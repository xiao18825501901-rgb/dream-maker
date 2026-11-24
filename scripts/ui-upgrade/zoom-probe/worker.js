// Test-only, in a fresh profile. No content scripts, cookies or network capability.
self.zoomOwnedTab = async origin => {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw Error('OWN_LOOPBACK_ORIGIN_REQUIRED');
  const tabs = await chrome.tabs.query({});
  const owned = tabs.filter(tab => tab.url?.startsWith(origin + '/'));
  if (owned.length !== 1) throw Error('ONE_OWNED_TAB_REQUIRED');
  await chrome.tabs.setZoomSettings(owned[0].id, { mode: 'automatic', scope: 'per-tab' });
  await chrome.tabs.setZoom(owned[0].id, 2);
  return chrome.tabs.getZoom(owned[0].id);
};
