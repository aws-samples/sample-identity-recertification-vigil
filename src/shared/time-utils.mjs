/**
 * Timestamp conversion utilities.
 * Store UTC ISO 8601 + epoch ms internally, display IST (UTC+5:30) externally.
 * @module shared/time-utils
 */

/** IST offset in milliseconds: +5 hours 30 minutes */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Convert a UTC Date to IST ISO 8601 string with +05:30 offset.
 * @param {Date} utcDate - Date object in UTC
 * @returns {string} IST ISO 8601 string, e.g. "2026-05-04T16:00:00.000+05:30"
 */
const toIST = (utcDate) => {
  const date = utcDate instanceof Date ? utcDate : new Date(utcDate);
  const istTime = new Date(date.getTime() + IST_OFFSET_MS);
  const iso = istTime.toISOString().replace('Z', '+05:30');
  return iso;
};

/**
 * Convert an IST Date/string to UTC Date.
 * @param {Date|string} istDate - Date in IST
 * @returns {Date} Date object in UTC
 */
const toUTC = (istDate) => {
  if (typeof istDate === 'string') {
    // If the string has +05:30 offset, Date constructor handles it
    if (istDate.includes('+05:30')) {
      return new Date(istDate);
    }
    // Treat as IST time without offset - subtract IST offset to get UTC
    const asUtc = new Date(istDate);
    return new Date(asUtc.getTime() - IST_OFFSET_MS);
  }
  const date = istDate instanceof Date ? istDate : new Date(istDate);
  return new Date(date.getTime() - IST_OFFSET_MS);
};

/**
 * Return epoch milliseconds for a Date.
 * @param {Date|string} date
 * @returns {number} Milliseconds since Unix epoch
 */
const toEpoch = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return d.getTime();
};

/**
 * Return UTC ISO 8601 string for a Date.
 * @param {Date|string} date
 * @returns {string} UTC ISO 8601 string, e.g. "2026-05-04T10:30:00.000Z"
 */
const toISOString = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString();
};

/**
 * Truncate an ISO 8601 string to second precision for deduplication keys.
 * Removes milliseconds: "2026-05-04T10:30:00.123Z" -> "2026-05-04T10:30:00Z"
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string} Truncated ISO string without milliseconds
 */
const truncateToSecond = (isoString) => {
  return isoString.replace(/\.\d{3}Z$/, 'Z').replace(/\.\d{3}\+/, '+');
};

export { toIST, toUTC, toEpoch, toISOString, truncateToSecond };
