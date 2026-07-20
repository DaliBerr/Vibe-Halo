"use strict";

// The 32 px asset is already simplified for small sizes, but its soft halo
// leaves the opaque terminal body too small in a 16 px Windows tray slot.
// Crop only the faint outer margin, then provide explicit 1x and 2x images.
const TRAY_SOURCE_CROP = Object.freeze({ x: 5, y: 4, width: 22, height: 22 });

function createTrayImage(nativeImage, sourcePath) {
  let source = null;
  try {
    source = nativeImage.createFromPath(sourcePath);
    if (source.isEmpty()) return nativeImage.createEmpty();
    const cropped = source.crop(TRAY_SOURCE_CROP);
    const image = cropped.resize({ width: 16, height: 16, quality: "best" });
    const retina = cropped.resize({ width: 32, height: 32, quality: "best" });
    image.addRepresentation({ scaleFactor: 2, dataURL: retina.toDataURL() });
    return image;
  } catch {
    try {
      if (source && !source.isEmpty()) {
        return source.resize({ width: 16, height: 16, quality: "best" });
      }
    } catch {
      // Fall through to Electron's safe empty-image value.
    }
    return nativeImage.createEmpty();
  }
}

module.exports = { TRAY_SOURCE_CROP, createTrayImage };
