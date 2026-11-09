/**
 * Real-Time Weather Tool powered by Open-Meteo
 * Free, open weather API requiring zero API keys or authentication.
 */

// WMO Weather interpretation codes (WW)
const WMO_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
};

export async function getWeather(args = {}) {
  const location = String(args.location || '').trim();
  if (!location) {
    return { status: 'error', message: 'Missing location parameter.' };
  }

  try {
    // 1. Geocoding
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      location
    )}&count=1&language=en&format=json`;

    const geoRes = await fetch(geoUrl, {
      signal: AbortSignal.timeout(5000),
    });

    if (!geoRes.ok) {
      return { status: 'error', message: `Geocoding failed with status ${geoRes.status}` };
    }

    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      return { status: 'not_found', message: `Location '${location}' was not found.` };
    }

    const place = geoData.results[0];
    const { latitude, longitude, name, country, admin1 } = place;

    // 2. Weather forecast
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
    const weatherRes = await fetch(weatherUrl, {
      signal: AbortSignal.timeout(5000),
    });

    if (!weatherRes.ok) {
      return { status: 'error', message: `Weather lookup failed with status ${weatherRes.status}` };
    }

    const weatherData = await weatherRes.json();
    const current = weatherData.current_weather;

    if (!current) {
      return { status: 'error', message: 'Current weather data unavailable.' };
    }

    const condition = WMO_CODES[current.weathercode] || 'Variable conditions';

    return {
      status: 'success',
      location: `${name}${admin1 ? `, ${admin1}` : ''}, ${country || ''}`,
      coordinates: { latitude, longitude },
      temperature_celsius: current.temperature,
      windspeed_kmh: current.windspeed,
      wind_direction: current.winddirection,
      condition,
      is_day: current.is_day === 1 ? 'day' : 'night',
      time: current.time,
    };
  } catch (err) {
    return {
      status: 'error',
      message: `Weather service error: ${err.message}`,
    };
  }
}
