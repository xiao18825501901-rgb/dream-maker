import {FrontendReviewAdapter} from './frontend-review-api.js';
import {DreamMakerUI} from './ui.js';
// Dedicated local frontend review, selected only by this compiled entry.
void new DreamMakerUI(new FrontendReviewAdapter('dream-maker')).boot();
