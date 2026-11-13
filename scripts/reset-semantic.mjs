import path from 'node:path';
import {resetSemantic} from '../dist/semantic/reset.js';

const args=process.argv.slice(2),at=args.indexOf('--data-dir');
if(at<0||!args[at+1]||!args.includes('--discard-existing'))throw new Error('Usage: node scripts/reset-semantic.mjs --data-dir <directory> --discard-existing');
console.log(JSON.stringify(await resetSemantic(path.resolve(args[at+1]),true)));
