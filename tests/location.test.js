import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveUserLocation,
  getUserLocation,
  calculateDistanceMeters,
  formatDistance,
  searchNearbyPlaces,
  formatPlacesSummary,
  LOCATION_CATEGORIES,
} from '../src/location.js';

test('Location: saveUserLocation and getUserLocation store and retrieve user coordinates', async () => {
  const userId = 'user_loc_test_1';
  const location = {
    latitude: 12.9716,
    longitude: 77.5946,
    name: 'Cubbon Park',
    address: 'Bengaluru, Karnataka',
  };

  const saved = await saveUserLocation(userId, location);
  assert.strictEqual(saved, true);

  const retrieved = await getUserLocation(userId);
  assert.ok(retrieved);
  assert.strictEqual(retrieved.latitude, 12.9716);
  assert.strictEqual(retrieved.longitude, 77.5946);
  assert.strictEqual(retrieved.name, 'Cubbon Park');
  assert.strictEqual(retrieved.address, 'Bengaluru, Karnataka');
  assert.ok(retrieved.updatedAt);
});

test('Location: calculateDistanceMeters and formatDistance calculate valid geographic distances', () => {
  // Bangalore (12.9716, 77.5946) to Whitefield (12.9698, 77.7500) is approx ~16-17 km
  const dist = calculateDistanceMeters(12.9716, 77.5946, 12.9698, 77.75);
  assert.ok(dist > 15000 && dist < 18000);

  assert.strictEqual(formatDistance(450), '~450m');
  assert.strictEqual(formatDistance(2400), '~2.4 km');
});

test('Location: searchNearbyPlaces returns categorized places with directions URLs', async () => {
  const places = await searchNearbyPlaces({
    latitude: 12.9716,
    longitude: 77.5946,
    category: 'cafe',
  });

  assert.ok(Array.isArray(places));
  assert.ok(places.length >= 2);

  const first = places[0];
  assert.ok(first.name);
  assert.ok(first.rating > 0);
  assert.ok(first.distanceFormatted);
  assert.ok(first.mapsUrl.startsWith('https://www.google.com/maps/dir/'));
  assert.ok(first.mapsUrl.includes('destination='));
});

test('Location: formatPlacesSummary builds clean mobile WhatsApp card layout', () => {
  const samplePlaces = [
    {
      name: 'Third Wave Coffee',
      rating: 4.6,
      userRatingsTotal: 1240,
      distanceFormatted: '~450m',
      address: '12th Main, Indiranagar',
      mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=12.9716,77.5946',
    },
  ];

  const formatted = formatPlacesSummary(samplePlaces, '📍 Nearby Cafes');
  assert.ok(formatted.includes('📍 Nearby Cafes'));
  assert.ok(formatted.includes('*1. Third Wave Coffee*'));
  assert.ok(formatted.includes('• *Rating:* ⭐ 4.6'));
  assert.ok(formatted.includes('• *Distance:* ~450m'));
  assert.ok(formatted.includes('• *Directions:* https://www.google.com/maps/dir/'));
  assert.strictEqual(formatted.includes('|'), false);
});

test('Location: LOCATION_CATEGORIES exposes standard place categories', () => {
  assert.ok(LOCATION_CATEGORIES.cafe);
  assert.ok(LOCATION_CATEGORIES.food);
  assert.ok(LOCATION_CATEGORIES.pharmacy);
  assert.ok(LOCATION_CATEGORIES.atm);
  assert.ok(LOCATION_CATEGORIES.fuel);
});
