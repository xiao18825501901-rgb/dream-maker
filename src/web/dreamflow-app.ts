import { LocalApiAdapter } from './local-api.js';
import { DreamMakerUI } from './ui.js';
// Fixed entry; query/storage cannot enable model P1 or replace the local adapter.
void new DreamMakerUI(new LocalApiAdapter(),undefined,'dreamflow').boot();
