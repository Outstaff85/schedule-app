// The map picker (React migration stage 8e-3), drawn into the page's
// #mapPickOverlay (the page opens it over the client window —
// ManagerBridge.pickPlace — so it goes back to that window when it closes):
// Google Maps with a search box (Places autocomplete), a pin to tap or drag, a
// live circle of the punch-clock radius and "Use my location". The place
// picked goes back to the client window (`onPick`: lat, lng, radius and a
// maps link). The Maps script is loaded on the first open (maps.ts).
import * as React from 'react';
import { IconCheck, IconCurrentLocation } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { showToast } from './toast';
import { MAP_DEFAULT_CENTER, loadGoogleMaps } from './maps';

export type MapPlace = { lat: number; lng: number; radius: number; mapsUrl: string };
export type MapPickProps = {
  start: { lat?: number | string | null; lng?: number | string | null; radius?: number | string | null; addr?: string } | null;
  onPick: ((p: MapPlace) => void) | null;
  /** closes the window (the page's closeModal) */
  close: () => void;
  seq: number;
};

/** Sets the pin from outside the map (the browser checks: there is no Google Maps on the emulators). */
export const mapPicker: { at: (lat: number, lng: number) => void } = { at: () => {} };

/* eslint-disable @typescript-eslint/no-explicit-any -- the Google Maps objects come untyped from its script */
export function MapPicker({ props }: { props: MapPickProps }) {
  const mapEl = React.useRef<HTMLDivElement>(null);
  const searchEl = React.useRef<HTMLDivElement>(null);
  const radiusEl = React.useRef<HTMLInputElement>(null);
  const g = React.useRef<{ map: any; marker: any; circle: any }>({ map: null, marker: null, circle: null });
  const [pos, setPos] = React.useState<{ lat: number; lng: number } | null>(null);
  const [noSearch, setNoSearch] = React.useState(false);
  const radius = () => Number(radiusEl.current?.value) || 100;

  const place = React.useCallback((lat: number, lng: number, recenter: boolean) => {
    setPos({ lat, lng });
    const p = { lat, lng }, { map, marker, circle } = g.current;
    if (marker) { marker.setPosition(p); marker.setVisible(true); }
    if (circle) { circle.setCenter(p); circle.setRadius(radius()); circle.setVisible(true); }
    if (recenter && map) { map.setCenter(p); map.setZoom(17); }
  }, []);
  React.useEffect(() => { mapPicker.at = (lat, lng) => place(lat, lng, false); }, [place]);

  React.useEffect(() => {
    let gone = false;
    const s = props.start;
    const lat = s && s.lat != null ? Number(s.lat) : NaN, lng = s && s.lng != null ? Number(s.lng) : NaN;
    const addr = String((s && s.addr) || '').trim(), hasPos = !isNaN(lat) && !isNaN(lng);
    (async () => {
      try { await loadGoogleMaps(); } catch (e) { showToast((e as Error).message); props.close(); return; }
      if (gone || !mapEl.current) return;
      const google = (window as any).google;
      const { Map, Circle } = await google.maps.importLibrary('maps');
      const { Marker } = await google.maps.importLibrary('marker');
      if (gone || !mapEl.current) return;
      const map = new Map(mapEl.current, {
        center: hasPos ? { lat, lng } : MAP_DEFAULT_CENTER, zoom: hasPos ? 17 : 12,
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false, gestureHandling: 'greedy',
      });
      // Classic Marker (not AdvancedMarkerElement) — the advanced one requires a
      // Cloud-configured Map ID; this keeps setup to just the API key.
      const marker = new Marker({ map, draggable: true, visible: false });
      const circle = new Circle({ map, visible: false, strokeColor: '#4f8cff', strokeWeight: 2, fillColor: '#4f8cff', fillOpacity: 0.15, clickable: false });
      g.current = { map, marker, circle };
      marker.addListener('dragend', (e: any) => place(e.latLng.lat(), e.latLng.lng(), false));
      map.addListener('click', (e: any) => place(e.latLng.lat(), e.latLng.lng(), false));
      if (hasPos) place(lat, lng, false);
      else if (addr) {
        try {
          const { Geocoder } = await google.maps.importLibrary('geocoding');
          new Geocoder().geocode({ address: addr, region: 'il' }, (res: any, status: string) => {
            if (status === 'OK' && res[0] && !gone) { map.setCenter(res[0].geometry.location); map.setZoom(17); }
          });
        } catch { /* no geocoding: the map stays on Tel Aviv */ }
      }
      // Places search box (new PlaceAutocompleteElement). Older builds fire
      // 'gmp-placeselect' with event.place, newer 'gmp-select' with
      // event.placePrediction — handle both.
      try {
        const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
        if (gone || !searchEl.current) return;
        const ac = new PlaceAutocompleteElement({ includedRegionCodes: ['il'] });
        ac.style.width = '100%';
        searchEl.current.replaceChildren(ac);
        const onPlace = async (pl: any) => {
          if (!pl) return;
          await pl.fetchFields({ fields: ['location', 'formattedAddress'] });
          if (pl.location) place(pl.location.lat(), pl.location.lng(), true);
        };
        ac.addEventListener('gmp-select', (e: any) => onPlace(e.placePrediction && e.placePrediction.toPlace()));
        ac.addEventListener('gmp-placeselect', (e: any) => onPlace(e.place));
      } catch { setNoSearch(true); }
    })();
    return () => { gone = true; };
  }, [props, place]);

  const useMyLocation = () => {
    if (!navigator.geolocation) { showToast(tr('Geolocation not supported on this device')); return; }
    navigator.geolocation.getCurrentPosition(
      p => { place(p.coords.latitude, p.coords.longitude, true); showToast(tr('Accuracy ±{0} m', { 0: Math.round(p.coords.accuracy) })); },
      err => showToast(tr('Could not get location: {0}', { 0: err.message })),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };
  const save = () => {
    if (!pos) return;
    const lat = +pos.lat.toFixed(6), lng = +pos.lng.toFixed(6);
    props.onPick?.({ lat, lng, radius: radius(), mapsUrl: 'https://www.google.com/maps?q=' + lat + ',' + lng });
    props.close();
  };

  return (
    <div data-testid="map-picker">
      <div className="modal-title">{tr('Pick location')}</div>
      <div ref={searchEl} style={{ marginBottom: 8 }}>
        {noSearch && <div style={{ fontSize: 12, color: 'var(--text3)' }}>{tr('Address search unavailable — tap the map instead')}</div>}
      </div>
      <div ref={mapEl} style={{ width: '100%', height: 360, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border2)', background: 'var(--bg3)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button className="btn sm" type="button" onClick={useMyLocation}><IconCurrentLocation className="size-4" /> <span>{tr('Use my location')}</span></button>
        <label style={{ fontSize: 12, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}><span>{tr('Radius (m)')}</span>
          <input ref={radiusEl} type="number" id="mapPickRadius" min={10} step={5} style={{ width: 80 }} defaultValue={Number(props.start?.radius) || 100}
            onInput={() => g.current.circle?.setRadius(radius())} /></label>
        <span id="mapPickCoords" style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 'auto' }}>{pos ? pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5) : ''}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>{tr('Search an address, or tap the map / drag the pin. The circle is the punch-clock radius.')}</div>
      <div className="modal-actions">
        <button className="gbtn primary og-save" type="button" id="mapPickSave" onClick={save} disabled={!pos}><IconCheck className="size-4" /><span>{tr('Use this location')}</span></button>
      </div>
    </div>
  );
}
