"use strict";
// Media storage behind one small interface: put / publicUrl / read.
//
// Key layout (stable, CDN-friendly): listings/<listing_id>/<photos|videos>/<uuid>.<ext>
// Local driver: files under UPLOAD_DIR, served by this server at /media/<key>.
//
// CDN swap point: write an S3 or Cloudinary driver with the same three methods and
// return the CDN base URL from publicUrl(). Nothing else in the app changes.
// Example: publicUrl(key) => "https://<bucket-or-cdn-host>/" + key
// Do not sign up for a paid CDN until volume justifies it (see the PRD, section 19).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LIMITS = {
  photo: { max: 8 * 1024 * 1024, types: { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" } },
  video: { max: 40 * 1024 * 1024, types: { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" } }
};
const KEY_RE = /^listings\/[A-Za-z0-9-]{4,64}\/(photos|videos)\/[a-f0-9-]{36}\.(jpg|png|webp|mp4|webm|mov)$/;

function localDriver(uploadDir) {
  return {
    name: "local",
    put(key, buf) {
      const full = path.join(uploadDir, key);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      return key;
    },
    publicUrl(key) {
      return "/media/" + key;
    },
    stream(key) {
      if (!KEY_RE.test(key)) return null;
      const full = path.join(uploadDir, key);
      return fs.existsSync(full) ? fs.createReadStream(full) : null;
    }
  };
}

function createStorage(dataDir) {
  const uploadDir = process.env.UPLOAD_DIR || path.join(dataDir, "uploads");
  // To move to S3 or Cloudinary, replace this line with that driver.
  const driver = localDriver(uploadDir);
  return {
    driver,
    limits: LIMITS,
    keyRe: KEY_RE,
    validate(kind, contentType, size) {
      const spec = LIMITS[kind];
      if (!spec) return "unknown media kind";
      if (!spec.types[contentType]) return kind + " must be " + Object.keys(spec.types).join(", ");
      if (!size) return "empty file";
      if (size > spec.max) return kind + " is too large (max " + Math.round(spec.max / 1048576) + " MB)";
      return null;
    },
    newKey(listingId, kind, contentType) {
      const ext = LIMITS[kind].types[contentType];
      return "listings/" + listingId + "/" + kind + "s/" + crypto.randomUUID() + ext;
    }
  };
}

module.exports = { createStorage, LIMITS, KEY_RE };
