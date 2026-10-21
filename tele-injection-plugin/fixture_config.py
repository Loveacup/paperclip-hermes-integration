"""Synthetic installation/owner scope fixture; does not import Hermes."""
from contextlib import contextmanager
from contextvars import ContextVar
import copy
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace, ModuleType
from unittest.mock import patch

@contextmanager
def registration(plugin, binding, risk=False):
    with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
        root=Path(tmp)
        config=json.loads((Path(__file__).resolve().parents[1]/'integration.example.json').read_text())
        config['configPath']=str(root/'config.json')
        config['bridge']['statePath']=str(root/'state.json')
        config['plugin'].update(enabled=True,binding=dict(binding),accept_nonatomic_risk=risk,interval=1,
                                ownerHome=str(root/'owner'),routingHome=str(root/'routing'),cursorDir=str(root/'cursors'))
        variable=ContextVar('synthetic_home',default='ambient-synthetic')
        constants=ModuleType('hermes_constants')
        constants.set_hermes_home_override=variable.set
        constants.reset_hermes_home_override=variable.reset
        constants.get_hermes_home=variable.get
        unload=[]
        def get_config(k,default=None):
            if variable.get()!=config['plugin']['ownerHome']:
                return default
            return config['configPath'] if k=='config_path' else default
        ctx=SimpleNamespace(get_config=get_config,_manager=SimpleNamespace(home_path=config['plugin']['ownerHome'],_cli_ref=None,has_gateway_message_injector=False),on_unload=unload.append)
        with patch.dict('sys.modules',{'hermes_constants':constants}), patch.object(plugin,'load_config',side_effect=lambda _:copy.deepcopy(config)):
            try:yield plugin,ctx,config,unload
            finally:
                for close in unload:close()
