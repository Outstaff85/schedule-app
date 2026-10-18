// Google Maps for the manager app (the map picker, MapPicker.tsx): the
// JavaScript API is loaded only when the picker first opens. The key is a
// browser key restricted by HTTP referrer to this app's domains, with Maps
// JavaScript API, Places API (New) and Geocoding API enabled.
import { tr } from './logic/i18n';
import { showToast } from './toast';

export const GOOGLE_MAPS_API_KEY = 'AIzaSyDlS9G5zOhg8lK88_jzHewC5BLM1QkeKwc';
export const MAP_DEFAULT_CENTER = { lat: 32.0853, lng: 34.7818 }; // Tel Aviv

let loading: Promise<void> | null = null;
/** Loads the Maps script once; resolves when `google.maps.importLibrary` can be used. */
export function loadGoogleMaps(): Promise<void> {
  const g = (window as unknown as { google?: { maps?: { importLibrary?: unknown } } }).google;
  if (g && g.maps && g.maps.importLibrary) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    (window as unknown as { __gmapsReady?: () => void }).__gmapsReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(GOOGLE_MAPS_API_KEY) + '&v=weekly&loading=async&callback=__gmapsReady';
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error('Google Maps failed to load')); };
    document.head.appendChild(s);
  });
  return loading;
}
// Google calls this global on an invalid / unauthorized key.
(window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
  showToast(tr('Google Maps key rejected — check GOOGLE_MAPS_API_KEY and its allowed domains'), 5000);
};
