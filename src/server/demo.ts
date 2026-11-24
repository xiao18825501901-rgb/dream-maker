import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { put } from './workspace.js';
export function buildDemo(root: string, workspace: string, fault: boolean) {
    for (const name of ['index.html', 'style.css', 'board.mjs', 'app.mjs', 'README.md']) {
        let content = readFileSync(resolve(root, 'examples/study-board', name), 'utf8');
        if (name === 'board.mjs' && fault)
            content = content.replace('!task.done', 'task.done');
        put(workspace, name, content);
    }
}
