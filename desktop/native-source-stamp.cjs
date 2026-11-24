'use strict';

const prefix = 'es-stamp-sha256-v1:';
const tagged = /^es-stamp-sha256-v1:[a-f0-9]{64}$/;
const fields = ['graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'];

/** The old strings are full scientific fingerprints, and can legitimately be
 * large. Only malformed versioned encodings are rejected at this layer. */
function validSourceStampFingerprints(stamp) {
  if (!stamp || fields.some(key => typeof stamp[key] !== 'string')) return false;
  return fields.some(key => stamp[key].startsWith(prefix))
    ? fields.every(key => tagged.test(stamp[key]))
    : true;
}

function sameSourceStamp(left, right) {
  if (!left || !right || Object.keys(left).length !== Object.keys(right).length) return false;
  return Object.keys(left).every(key => {
    if (!Object.hasOwn(right, key)) return false;
    const a = left[key], b = right[key];
    return a === b || !!a && !!b && typeof a === 'object' && typeof b === 'object'
      && sameSourceStamp(a, b);
  });
}

module.exports = { validSourceStampFingerprints, sameSourceStamp };
