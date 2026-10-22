"""One-shot native completion; caller owns QA verification. No retry or fallback."""
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, ProxyHandler, build_opener

UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z')


HTTP_ORIGIN_ENV = 'SEGMENTED_QA_ALLOWED_HTTP_ORIGIN'


def _allowed_http_origin(value):
    """Validate, never normalize, the administrator's single plaintext origin."""
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(
            r'http://(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::[0-9]+)?', value):
        raise ValueError('invalid allowed HTTP origin')
    u = urlsplit(value)
    # Reject empty DNS labels and invalid label boundaries; urlsplit validates IPv6.
    if not u.hostname or (':' not in u.hostname and any(
            not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
            for label in u.hostname.split('.'))):
        raise ValueError('invalid allowed HTTP origin')
    if u.port is not None and not 1 <= u.port <= 65535:
        raise ValueError('invalid allowed HTTP origin')
    return value


def _base_url(value, allowed_http_origin=None):
    allowed_http_origin = _allowed_http_origin(allowed_http_origin)
    if not isinstance(value, str) or any(c.isspace() for c in value):
        raise ValueError('invalid base')
    u = urlsplit(value)
    if (u.scheme not in ('http', 'https') or not u.hostname or '@' in u.netloc
            or '?' in value or '#' in value or u.path not in ('', '/', '/api', '/api/') or '\\' in value):
        raise ValueError('invalid base')
    origin = value[:-len(u.path)] if u.path else value
    if allowed_http_origin is not None and origin != allowed_http_origin:
        raise ValueError('allowed HTTP origin mismatch')
    if u.scheme == 'http' and u.hostname not in ('localhost', '127.0.0.1', '::1') and allowed_http_origin is None:
        raise ValueError('insecure remote base')
    u.port  # validate malformed port before use
    return u._replace(path='', query='', fragment='').geturl()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, 'redirect refused', {}, None)


def _transport(base, allowed_http_origin=None):
    base = _base_url(base, allowed_http_origin)
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    def request(method, path, body, headers):
        if not re.fullmatch(r'/api/(?:agents/me|heartbeat-runs/[0-9a-fA-F-]+|issues/[0-9a-fA-F-]+(?:/comments)?)', path):
            raise ValueError('invalid path')
        data = None if body is None else json.dumps(body).encode()
        req = Request(base+path, data=data, headers={**headers, 'Content-Type': 'application/json'}, method=method)
        with opener.open(req, timeout=10) as response:
            return json.load(response)
    return request


def finish_current_issue(*, summary, receipt_sha256, intent_dir, env=None, transport=None):
    """Return read_back/refused/needs_reconciliation. Never serialize remote errors.

    State: absent -> validated -> durable unknown -> at most one PATCH -> read_back.
    The intent deliberately stays unknown even after success: it is a permanent
    no-replay fence, not a receipt. A duplicate always needs external reconciliation.
    """
    attempted = False
    def result(status, reason):
        return {'status': status, 'verified': status == 'read_back', 'reason': reason}
    try:
        directory = Path(intent_dir)
        intent_path = directory/'finish.intent.json'
        if os.path.lexists(intent_path):
            return result('needs_reconciliation', 'existing_intent_no_retry')
        env = os.environ if env is None else env
        agent, company, run = (env['PAPERCLIP_'+k] for k in ('AGENT_ID', 'COMPANY_ID', 'RUN_ID'))
        token = env['PAPERCLIP_API_KEY']
        allowed_http_origin = _allowed_http_origin(env.get(HTTP_ORIGIN_ENV))
        base = _base_url(env['PAPERCLIP_API_URL'], allowed_http_origin)
        if not all(isinstance(v, str) and UUID.fullmatch(v) for v in (agent, company, run)):
            return result('refused', 'invalid_runtime_ids')
        if not isinstance(token, str) or not token or any(c.isspace() for c in token):
            return result('refused', 'invalid_runtime_credential')
        if (not isinstance(summary, str) or not summary.strip() or len(summary)>4000
                or token in summary or not isinstance(receipt_sha256, str)
                or not re.fullmatch('[0-9a-f]{64}', receipt_sha256)):
            return result('refused', 'invalid_summary_or_digest')
        transport = transport if transport is not None else _transport(base, allowed_http_origin)
        headers = {'Authorization': 'Bearer '+token, 'X-Paperclip-Run-Id': run}
        me = transport('GET', '/api/agents/me', None, headers)
        runtime = transport('GET', '/api/heartbeat-runs/'+run, None, headers)
        if (me.get('id') != agent or me.get('companyId') != company or
                runtime.get('id') != run or runtime.get('companyId') != company or
                runtime.get('agentId') != agent or runtime.get('status') != 'running'):
            return result('refused', 'runtime_binding_mismatch')
        context = runtime.get('contextSnapshot') or {}
        if not isinstance(context, dict):
            return result('refused', 'ambiguous_issue_binding')
        # taskKey is a wake/session key, not an authoritative issue identity.
        bindings = ([runtime['nativeIssueId']] if runtime.get('nativeIssueId') is not None else [])
        bindings += [context[k] for k in ('issueId', 'taskId') if context.get(k) is not None]
        if not bindings or not all(isinstance(v, str) and UUID.fullmatch(v) and v == bindings[0] for v in bindings):
            return result('refused', 'ambiguous_issue_binding')
        issue = bindings[0]
        if env.get('PAPERCLIP_TASK_ID', issue) != issue:
            return result('refused', 'task_binding_mismatch')
        path = '/api/issues/'+issue
        before = transport('GET', path, None, headers)
        def own(item):
            return (isinstance(item, dict) and item.get('id') == issue and item.get('companyId') == company
                    and item.get('assigneeAgentId') == agent and not item.get('assigneeUserId'))
        if not own(before) or before.get('status') not in ('todo', 'in_progress', 'in_review'):
            return result('refused', 'issue_not_current_owned_work')
        comment = summary+'\n\n[segmented-qa receipt-sha256='+receipt_sha256+' run='+run+']'
        intent = {'state': 'unknown', 'issue_id': issue, 'run_id': run, 'agent_id': agent,
                  'company_id': company, 'receipt_sha256': receipt_sha256,
                  'comment_sha256': hashlib.sha256(comment.encode()).hexdigest()}
        fd = os.open(intent_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(intent, handle)
            handle.flush()
            os.fsync(handle.fileno())
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        attempted = True
        reply = transport('PATCH', path, {'status': 'done', 'comment': comment}, headers)
        if not isinstance(reply, dict):
            return result('needs_reconciliation', 'unparseable_write_reply')
        after = transport('GET', path, None, headers)
        comments = transport('GET', path+'/comments', None, headers)
        verified = own(after) and after.get('status') == 'done' and isinstance(comments, list) and any(
            isinstance(c, dict) and c.get('issueId') == issue and c.get('companyId') == company
            and c.get('authorAgentId') == agent and c.get('body') == comment for c in comments)
        return result('read_back' if verified else 'needs_reconciliation', 'exact_readback' if verified else 'readback_mismatch')
    except FileExistsError:
        return result('needs_reconciliation', 'existing_intent_no_retry')
    except HTTPError as exc:
        return result('refused' if exc.code in (403, 409) or not attempted else 'needs_reconciliation', 'http_denied' if exc.code in (403, 409) else 'http_failure')
    except Exception:
        return result('needs_reconciliation' if attempted else 'refused', 'uncertain_write' if attempted else 'preflight_failed')
