// Vercel serverless function — GET /api/weather
// Uses the visitor's approximate location from Vercel's IP geo headers (no permission prompt),
// falls back to New York City, and reads current conditions from Open-Meteo (free, no key).

module.exports = async (req, res) => {
  const h = req.headers || {};
  let lat = parseFloat(h['x-vercel-ip-latitude']);
  let lon = parseFloat(h['x-vercel-ip-longitude']);
  let city = h['x-vercel-ip-city'] ? safeDecode(h['x-vercel-ip-city']) : '';
  const country = String(h['x-vercel-ip-country'] || '');

  if (isNaN(lat) || isNaN(lon)) { lat = 40.7128; lon = -74.006; city = 'New York City'; }
  if (!city) city = 'your area';

  const useF = !country || ['US', 'LR', 'MM'].includes(country);

  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&current=temperature_2m,weather_code,is_day&temperature_unit=celsius';
    const r = await fetch(url);
    if (!r.ok) throw new Error('weather ' + r.status);
    const j = await r.json();
    const tempC = j.current.temperature_2m;
    res.setHeader('Cache-Control', 'private, max-age=600');
    return res.json({
      city,
      tempC,
      temp: useF ? tempC * 9 / 5 + 32 : tempC,
      unit: useF ? 'F' : 'C',
      code: j.current.weather_code,
      isDay: j.current.is_day === 1
    });
  } catch (e) {
    return res.status(502).json({ error: 'Weather unavailable' });
  }
};

function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
