// src/MapView.jsx
// Renders every connected device as a live marker, its origin and
// destination as small pins, every ambulance's own route, and this
// device's current + just-avoided route. Destination can be set either by
// clicking the map or by typing into the search bar.

import { useCallback, useMemo, useRef } from 'react';
import {
  GoogleMap,
  Marker,
  Polyline,
  Autocomplete,
  useJsApiLoader,
} from '@react-google-maps/api';

const containerStyle = { width: '100%', height: '65vh' };
const libraries = ['places'];

const defaultCenter = { lat: 12.9716, lng: 77.5946 };

// This project is India-only end to end — restrict place search to India too,
// so the map, the search box and the backend's own India-only check all agree.
const INDIA_AUTOCOMPLETE_OPTIONS = { componentRestrictions: { country: 'in' } };

const ROLE_COLOR = {
  ambulance: '#ef4444',
  vehicle: '#3b82f6',
};

const AMBULANCE_ICON = {
  path: 'M -6,-6 6,-6 6,6 -6,6 Z',
  fillColor: ROLE_COLOR.ambulance,
  fillOpacity: 1,
  strokeWeight: 1,
  strokeColor: '#7f0000',
  scale: 1.6,
};

// Key derived from a route's geometry. Changing a Polyline's `path` in place
// doesn't reliably repaint on Google's vector map (the old line can stay on
// screen), so a different route gets a different key and is redrawn fresh.
function routeKey(polyline) {
  if (!polyline?.length) return 'none';
  const mid = polyline[Math.floor(polyline.length / 2)];
  return `${polyline.length}-${mid.lat}-${mid.lng}`;
}

const dashedIcon = {
  icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
  offset: '0',
  repeat: '10px',
};

export default function MapView({
  devices,
  myRoute,
  avoidedRoute,
  onSetDestination,
  onSetOrigin,
  pendingOrigin,
  mySocketId,
  staleDeviceIds,
}) {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
    libraries,
  });

  const mapRef = useRef(null);
  const originAutocompleteRef = useRef(null);
  const destAutocompleteRef = useRef(null);

  const onMapLoad = useCallback((map) => {
    mapRef.current = map;
  }, []);

  // Raster rendering: Google's default vector renderer can keep showing a
  // polyline's OLD path/colour after it changes (seen when a reroute swaps the
  // blue and red lines), which reads as "the route didn't change". Raster
  // repaints overlays reliably.
  const mapOptions = useMemo(() => {
    if (!isLoaded || !window.google) return undefined;
    return { renderingType: window.google.maps.RenderingType.RASTER };
  }, [isLoaded]);

  const vehicleIcon = useMemo(() => {
    if (!isLoaded || !window.google) return undefined;
    return {
      path: window.google.maps.SymbolPath.CIRCLE,
      fillColor: ROLE_COLOR.vehicle,
      fillOpacity: 1,
      strokeWeight: 1,
      strokeColor: '#1e3a8a',
      scale: 7,
    };
  }, [isLoaded]);

  // Small ring marker for an "origin" point, colored by role.
  const originIcon = useCallback(
    (role) => {
      if (!isLoaded || !window.google) return undefined;
      return {
        path: window.google.maps.SymbolPath.CIRCLE,
        fillColor: '#ffffff',
        fillOpacity: 1,
        strokeColor: ROLE_COLOR[role] || '#666',
        strokeWeight: 3,
        scale: 6,
      };
    },
    [isLoaded]
  );

  // Teardrop pin for a "destination" point, colored by role.
  const destinationIcon = useCallback(
    (role) => {
      if (!isLoaded || !window.google) return undefined;
      return {
        path: 'M 0,0 C -1.5,-1.5 -4.5,-4.5 -4.5,-7.5 A 4.5,4.5 0 1 1 4.5,-7.5 C 4.5,-4.5 1.5,-1.5 0,0 Z',
        fillColor: ROLE_COLOR[role] || '#666',
        fillOpacity: 1,
        strokeColor: '#1a1a1a',
        strokeWeight: 1,
        scale: 2.2,
        anchor: window.google ? new window.google.maps.Point(0, 0) : undefined,
      };
    },
    [isLoaded]
  );

  const handleMapClick = useCallback(
    (e) => {
      onSetDestination({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    },
    [onSetDestination]
  );

  const handlePlaceChangedDestination = () => {
    const place = destAutocompleteRef.current?.getPlace();
    if (!place || !place.geometry || !place.geometry.location) return;

    const lat = place.geometry.location.lat();
    const lng = place.geometry.location.lng();

    onSetDestination({ lat, lng });

    if (mapRef.current) {
      mapRef.current.panTo({ lat, lng });
      mapRef.current.setZoom(15);
    }
  };

  const handlePlaceChangedOrigin = () => {
    const place = originAutocompleteRef.current?.getPlace();
    if (!place || !place.geometry || !place.geometry.location) return;

    const lat = place.geometry.location.lat();
    const lng = place.geometry.location.lng();

    onSetOrigin({ lat, lng });

    if (mapRef.current) {
      mapRef.current.panTo({ lat, lng });
      mapRef.current.setZoom(15);
    }
  };

  const deviceList = useMemo(() => Object.entries(devices || {}), [devices]);

  // Centre on the first known device position ONCE. Recomputing this on every
  // devices-update made the map snap back every time a device moved, so you
  // couldn't pan or zoom while an ambulance was streaming. Searches still
  // pan the map explicitly via mapRef.
  const initialCenterRef = useRef(null);
  if (initialCenterRef.current === null) {
    const withPos = deviceList.find(([, d]) => d.lat != null && d.lng != null);
    if (withPos) initialCenterRef.current = { lat: withPos[1].lat, lng: withPos[1].lng };
  }
  const center = initialCenterRef.current || defaultCenter;

  if (!isLoaded) return <div className="map-loading">Loading map...</div>;

  return (
    <div className="map-shell">
      <div className="search-bar-wrap">
        <Autocomplete
          onLoad={(ac) => (originAutocompleteRef.current = ac)}
          onPlaceChanged={handlePlaceChangedOrigin}
          options={INDIA_AUTOCOMPLETE_OPTIONS}
        >
          <input
            type="text"
            placeholder="Start (optional — defaults to your live position)"
            className="search-bar search-bar-origin"
          />
        </Autocomplete>
        <Autocomplete
          onLoad={(ac) => (destAutocompleteRef.current = ac)}
          onPlaceChanged={handlePlaceChangedDestination}
          options={INDIA_AUTOCOMPLETE_OPTIONS}
        >
          <input type="text" placeholder="Destination" className="search-bar" />
        </Autocomplete>
      </div>

      <GoogleMap
        mapContainerStyle={containerStyle}
        center={center}
        zoom={15}
        onClick={handleMapClick}
        onLoad={onMapLoad}
        options={mapOptions}
      >
        {/* Live position of every device — dimmed if it hasn't updated recently */}
        {deviceList.map(([id, device]) => {
          if (device.lat == null || device.lng == null) return null;
          const isMe = id === mySocketId;
          const isStale = staleDeviceIds?.has(id);
          const baseIcon = device.role === 'ambulance' ? AMBULANCE_ICON : vehicleIcon;
          const icon = baseIcon ? { ...baseIcon, fillOpacity: isStale ? 0.35 : 1 } : baseIcon;
          return (
            <Marker
              key={`pos-${id}`}
              position={{ lat: device.lat, lng: device.lng }}
              icon={icon}
              title={`${device.label} (${device.role}${device.role === 'ambulance' && device.priority ? ` P${device.priority}` : ''})${isMe ? ' — you' : ''}${isStale ? ' — no recent update' : ' — live position'}`}
            />
          );
        })}

        {/* Origin pin for every device that has set a destination */}
        {deviceList.map(([id, device]) => {
          if (!device.origin) return null;
          return (
            <Marker
              key={`origin-${id}`}
              position={device.origin}
              icon={originIcon(device.role)}
              title={`${device.label} — origin`}
            />
          );
        })}

        {/* A Start point picked via search but not yet confirmed by a destination */}
        {pendingOrigin && (
          <Marker
            position={pendingOrigin}
            icon={originIcon('vehicle')}
            title="Pending start point — pick a destination to confirm"
          />
        )}

        {/* Destination pin for every device that has set a destination */}
        {deviceList.map(([id, device]) => {
          if (!device.destination) return null;
          return (
            <Marker
              key={`dest-${id}`}
              position={device.destination}
              icon={destinationIcon(device.role)}
              title={`${device.label} — destination`}
            />
          );
        })}

        {/* Every ambulance's own route — visible to everyone */}
        {deviceList.map(([id, device]) => {
          if (device.role !== 'ambulance' || !device.currentRoute?.polyline) return null;
          return (
            <Polyline
              key={`ambulance-route-${id}-${routeKey(device.currentRoute.polyline)}`}
              path={device.currentRoute.polyline}
              options={{
                strokeColor: '#f59e0b',
                strokeOpacity: 0.85,
                strokeWeight: 4,
                icons: [dashedIcon],
                zIndex: 1,
              }}
            />
          );
        })}

        {/* Other candidate routes that were considered — thin grey lines */}
        {(myRoute?.alternatives || []).map((alt, i) => (
          <Polyline
            key={`alt-${i}-${routeKey(alt.polyline)}`}
            path={alt.polyline}
            options={{
              strokeColor: '#9ca3af',
              strokeOpacity: 0.9,
              strokeWeight: 4,
              zIndex: 1,
            }}
          />
        ))}

        {/* The route just replaced (by a reroute, or by avoidance at the initial pick) — red "before"
            path. Most of it usually coincides with the new route (only the detoured
            section actually differs), so it's drawn noticeably WIDER than the current
            route on top of it — otherwise a same-width line underneath is invisible
            everywhere except the one stretch where they diverge. */}
        {avoidedRoute && avoidedRoute.polyline && (
          <Polyline
            key={`avoided-${routeKey(avoidedRoute.polyline)}`}
            path={avoidedRoute.polyline}
            options={{
              strokeColor: '#ef4444',
              strokeOpacity: 0.85,
              strokeWeight: 9,
              icons: [dashedIcon],
              zIndex: 2,
            }}
          />
        )}

        {/* This device's own current route, redrawn live on reroute — narrower than the
            red "before" line so the red still shows as a border along shared stretches,
            not just where the two routes actually diverge. */}
        {myRoute && myRoute.polyline && (
          <Polyline
            key={`my-${routeKey(myRoute.polyline)}`}
            path={myRoute.polyline}
            options={{
              strokeColor: '#3b82f6',
              strokeOpacity: 0.95,
              strokeWeight: 5,
              zIndex: 3,
            }}
          />
        )}
      </GoogleMap>
    </div>
  );
}
