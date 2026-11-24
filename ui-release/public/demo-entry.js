import { DemoScenarioAdapter } from './demo-api.js';
import { DreamMakerUI } from './ui.js';
// Build-time-only entry. No LocalApiAdapter import; no URL/storage-controlled mode switch.
const ui = new DreamMakerUI(new DemoScenarioAdapter());
void ui.boot();
