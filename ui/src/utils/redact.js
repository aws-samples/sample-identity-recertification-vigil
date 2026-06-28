/**
 * Demo redaction helper. When VITE_DEMO_MASK is "true", masks sensitive
 * identifiers (AWS account IDs and EC2 instance IDs) in any displayed string so
 * public screenshots, recordings, and the shared demo URL never expose them.
 * Keeps the last 4 characters so values stay distinguishable.
 * @module utils/redact
 */

export const MASK_ON = import.meta.env.VITE_DEMO_MASK === 'true';

/**
 * Mask sensitive identifiers in a string (no-op unless VITE_DEMO_MASK=true).
 * - AWS account id  364170696417            -> ••••••••6417   (also inside ARNs)
 * - EC2 instance id i-0070cd479cbff0c91     -> i-••••••••0c91
 * @param {*} text
 * @returns {*} masked string (or the original value if not a string / mask off)
 */
export const mask = (text) => {
  if (!MASK_ON || text == null || typeof text !== 'string') return text;
  return text
    .replace(/i-[0-9a-f]{4,}([0-9a-f]{4})\b/g, 'i-••••••••$1')
    .replace(/\b\d{8}(\d{4})\b/g, '••••••••$1');
};
