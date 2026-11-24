import { LocalApiAdapter } from './local-api.js';
import { DreamMakerUI, type FixtureData } from './ui.js';
import { SiwcLocalPanel } from './siwc-local.js';
let ui: DreamMakerUI | null = null;
/** Backward-compatible offline harness entry; does not create credentials or call APIs. */
export function renderFixture(data: FixtureData): void {
  if (!document.documentElement.hasAttribute('data-dm-ui-fixture')) throw new Error('Fixture document marker required');
  ui ??= new DreamMakerUI(new LocalApiAdapter()); ui.renderFixture(data);
}
if (!document.documentElement.hasAttribute('data-dm-ui-fixture')) { const api = new LocalApiAdapter();ui = new DreamMakerUI(api,new SiwcLocalPanel(api));void ui.boot(); }
