// Replays captured real OMP bytes; never invokes a model.
import {readFile} from 'node:fs/promises';
const mode=process.argv[2];
for await(const _ of process.stdin) {}
process.stdout.write(await readFile(new URL(`./fixtures/${mode}.jsonl`,import.meta.url)));
process.exitCode=/^[0-9]+$/.test(process.argv[3]??'') ? Number(process.argv[3]) : (mode==='provider-error'?1:0);
