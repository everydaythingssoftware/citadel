//! A cover's colours, worked out once from its decoded image: the palette the
//! book drawer's wash is tinted from and a ThumbHash the grid paints while the
//! cover loads. Both hosts call [`cover_colors`] on the thumbnail they already
//! resize, and cache the result with it.
//!
//! The palette is a port of the frontend's former picker: the cover's pixels
//! are grouped in OKLab (k-means), near-white, near-black and specks are set
//! aside, and the biggest groups that remain are the cover's colours. Nothing
//! is invented: a cover of one colour gets one colour.

use base64::Engine;
use image::{imageops::FilterType, DynamicImage};
use serde::{Deserialize, Serialize};

const CLUSTERS: usize = 6;
const ITERATIONS: usize = 10;
/// Groups smaller than this are specks: thin lines, small type.
const MIN_SHARE: f64 = 0.02;
/// Two colours closer than this read as the same colour.
const DISTINCT: f64 = 0.08;
/// The palette is picked from a downscale this many pixels square.
const SAMPLE_SIZE: u32 = 48;
/// ThumbHash takes images no bigger than this on either side.
const THUMBHASH_MAX: u32 = 100;

/// One of a cover's colours in OKLab, with how much of the cover it covers.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, specta::Type)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct PaletteColor {
    pub l: f64,
    pub a: f64,
    pub b: f64,
    /// Share of the cover's counted pixels in this colour, 0–1.
    pub share: f64,
}

/// A cover's main colour and, when it has one, a second distinct colour.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, specta::Type)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct CoverPalette {
    pub dominant: PaletteColor,
    #[cfg_attr(feature = "openapi", schema(required = true))]
    pub secondary: Option<PaletteColor>,
}

/// What a cover looks like before it loads.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, specta::Type)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct CoverColors {
    /// `None` when the cover is all paper and ink.
    #[cfg_attr(feature = "openapi", schema(required = true))]
    pub palette: Option<CoverPalette>,
    /// The cover's ThumbHash, base64 (standard, padded).
    pub thumbhash: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

fn to_linear(channel: u8) -> f64 {
    let c = f64::from(channel) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

pub fn srgb_to_oklab(r: u8, g: u8, b: u8) -> Oklab {
    let lr = to_linear(r);
    let lg = to_linear(g);
    let lb = to_linear(b);
    let l = (0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb).cbrt();
    let m = (0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb).cbrt();
    let s = (0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb).cbrt();
    Oklab {
        l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    }
}

pub fn chroma(color: Oklab) -> f64 {
    color.a.hypot(color.b)
}

/// Hue in degrees, 0–360.
pub fn hue(color: Oklab) -> f64 {
    (color.b.atan2(color.a) * 180.0 / std::f64::consts::PI + 360.0) % 360.0
}

pub fn distance(x: Oklab, y: Oklab) -> f64 {
    let (dl, da, db) = (x.l - y.l, x.a - y.a, x.b - y.b);
    (dl * dl + da * da + db * db).sqrt()
}

impl PaletteColor {
    pub fn oklab(&self) -> Oklab {
        Oklab {
            l: self.l,
            a: self.a,
            b: self.b,
        }
    }
}

/// Too close to paper or ink to say anything about the cover.
fn is_neutral_extreme(color: Oklab) -> bool {
    color.l < 0.16 || (color.l > 0.96 && chroma(color) < 0.03)
}

/// Spread starting centres across the colours present (farthest-first).
fn seed(points: &[Oklab]) -> Vec<Oklab> {
    let Some(&first) = points.first() else {
        return Vec::new();
    };
    let mut centres = vec![first];
    while centres.len() < CLUSTERS.min(points.len()) {
        let mut best = None;
        let mut best_distance = -1.0;
        for &point in points {
            let nearest = centres
                .iter()
                .map(|&centre| distance(point, centre))
                .fold(f64::INFINITY, f64::min);
            if nearest > best_distance {
                best_distance = nearest;
                best = Some(point);
            }
        }
        match best {
            Some(point) if best_distance != 0.0 => centres.push(point),
            _ => break,
        }
    }
    centres
}

fn cluster(points: &[Oklab]) -> Vec<PaletteColor> {
    let mut centres = seed(points);
    let mut assignment = vec![0usize; points.len()];
    for _ in 0..ITERATIONS {
        for (slot, &point) in assignment.iter_mut().zip(points) {
            let mut index = 0;
            let mut nearest = f64::INFINITY;
            for (i, &centre) in centres.iter().enumerate() {
                let d = distance(point, centre);
                if d < nearest {
                    nearest = d;
                    index = i;
                }
            }
            *slot = index;
        }
        for (i, centre) in centres.iter_mut().enumerate() {
            let members: Vec<Oklab> = points
                .iter()
                .zip(&assignment)
                .filter(|(_, &a)| a == i)
                .map(|(&point, _)| point)
                .collect();
            if members.is_empty() {
                continue;
            }
            let count = members.len() as f64;
            *centre = Oklab {
                l: members.iter().map(|m| m.l).fold(0.0, |sum, v| sum + v) / count,
                a: members.iter().map(|m| m.a).fold(0.0, |sum, v| sum + v) / count,
                b: members.iter().map(|m| m.b).fold(0.0, |sum, v| sum + v) / count,
            };
        }
    }
    centres
        .iter()
        .enumerate()
        .map(|(i, centre)| PaletteColor {
            l: centre.l,
            a: centre.a,
            b: centre.b,
            share: assignment.iter().filter(|&&a| a == i).count() as f64 / points.len() as f64,
        })
        .collect()
}

/// The cover's colours from its RGBA pixels (a small downscale is plenty).
/// `None` when the cover is all paper and ink, or transparent.
pub fn extract_cover_palette(rgba: &[u8]) -> Option<CoverPalette> {
    let points: Vec<Oklab> = rgba
        .chunks_exact(4)
        .filter(|pixel| pixel[3] >= 128)
        .map(|pixel| srgb_to_oklab(pixel[0], pixel[1], pixel[2]))
        .collect();
    if points.is_empty() {
        return None;
    }
    let mut colors: Vec<PaletteColor> = cluster(&points)
        .into_iter()
        .filter(|color| color.share >= MIN_SHARE && !is_neutral_extreme(color.oklab()))
        .collect();
    colors.sort_by(|x, y| {
        y.share
            .partial_cmp(&x.share)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let (&dominant, rest) = colors.split_first()?;
    let secondary = rest
        .iter()
        .find(|color| distance(color.oklab(), dominant.oklab()) >= DISTINCT)
        .copied();
    Some(CoverPalette {
        dominant,
        secondary,
    })
}

/// The palette and ThumbHash of a decoded cover.
pub fn cover_colors(image: &DynamicImage) -> CoverColors {
    let sample = image
        .resize_exact(SAMPLE_SIZE, SAMPLE_SIZE, FilterType::Triangle)
        .to_rgba8();
    let small = image.thumbnail(THUMBHASH_MAX, THUMBHASH_MAX).to_rgba8();
    let hash = thumbhash::rgba_to_thumb_hash(
        small.width() as usize,
        small.height() as usize,
        small.as_raw(),
    );
    CoverColors {
        palette: extract_cover_palette(sample.as_raw()),
        thumbhash: base64::engine::general_purpose::STANDARD.encode(hash),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    /// RGBA pixels: each (r, g, b, count) repeated `count` times.
    fn pixels(runs: &[(u8, u8, u8, usize)]) -> Vec<u8> {
        runs.iter()
            .flat_map(|&(r, g, b, count)| std::iter::repeat_n([r, g, b, 255], count))
            .flatten()
            .collect()
    }

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() < tolerance,
            "{actual} is not within {tolerance} of {expected}"
        );
    }

    #[test]
    fn takes_the_biggest_colour_first_and_a_distinct_second() {
        let palette = extract_cover_palette(&pixels(&[
            (113, 30, 29, 60),
            (165, 116, 80, 25),
            (250, 250, 250, 15),
        ]))
        .expect("palette");
        assert_close(
            hue(palette.dominant.oklab()),
            hue(srgb_to_oklab(113, 30, 29)),
            0.5,
        );
        assert_close(
            hue(palette.secondary.expect("secondary").oklab()),
            hue(srgb_to_oklab(165, 116, 80)),
            0.5,
        );
    }

    #[test]
    fn ignores_specks_near_white_and_near_black() {
        let palette = extract_cover_palette(&pixels(&[
            (234, 222, 176, 80),
            (20, 140, 60, 1),
            (5, 5, 5, 10),
            (255, 255, 255, 9),
        ]))
        .expect("palette");
        assert_eq!(palette.secondary, None);
        assert_close(
            hue(palette.dominant.oklab()),
            hue(srgb_to_oklab(234, 222, 176)),
            0.5,
        );
    }

    #[test]
    fn is_none_for_a_cover_of_only_paper_and_ink() {
        assert_eq!(
            extract_cover_palette(&pixels(&[(255, 255, 255, 50), (0, 0, 0, 50)])),
            None
        );
    }

    #[test]
    fn skips_transparent_pixels() {
        assert_eq!(extract_cover_palette(&[200, 40, 40, 0]), None);
    }

    #[test]
    fn srgb_to_oklab_matches_the_frontend() {
        // The values src/lib/cover-palette.ts's srgbToOklab returns.
        for (rgb, expected) in [
            (
                (113, 30, 29),
                (
                    0.37040097804772104,
                    0.10529253033248148,
                    0.05018077889338832,
                ),
            ),
            (
                (165, 116, 80),
                (0.600646289952844, 0.043683528881357736, 0.06685143353256301),
            ),
            (
                (40, 80, 120),
                (
                    0.42183394548483344,
                    -0.027271714012120363,
                    -0.07619850732504196,
                ),
            ),
            (
                (255, 255, 255),
                (
                    0.9999999934735462,
                    8.095285553011422e-11,
                    3.727390762708893e-8,
                ),
            ),
        ] {
            let color = srgb_to_oklab(rgb.0, rgb.1, rgb.2);
            assert_close(color.l, expected.0, 1e-9);
            assert_close(color.a, expected.1, 1e-9);
            assert_close(color.b, expected.2, 1e-9);
        }
    }

    #[test]
    fn cover_colors_reads_a_decoded_image_and_pins_its_thumbhash() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(600, 900, Rgb([40, 80, 120])));
        let colors = cover_colors(&image);
        let palette = colors.palette.expect("palette");
        assert_eq!(palette.secondary, None);
        assert_close(palette.dominant.share, 1.0, 1e-12);
        let blue = srgb_to_oklab(40, 80, 120);
        assert_close(palette.dominant.l, blue.l, 1e-9);
        assert_close(palette.dominant.a, blue.a, 1e-9);
        assert_close(palette.dominant.b, blue.b, 1e-9);
        // The AC terms go through f32 cos, whose last bits differ between
        // platforms' libm, so the hash is pinned by what it decodes to, not
        // byte for byte. src/lib/thumbhash.test.ts decodes the Linux hash,
        // "FLYBBQCGhnh4h4iHd3eH9weH+Ed4".
        let hash = base64::engine::general_purpose::STANDARD
            .decode(&colors.thumbhash)
            .expect("base64");
        assert_eq!(hash.len(), 21);
        let (r, g, b, a) = thumbhash::thumb_hash_to_average_rgba(&hash).expect("thumbhash");
        for (actual, expected) in [(r, 40.0), (g, 80.0), (b, 120.0), (a, 255.0)] {
            assert_close(f64::from(actual) * 255.0, expected, 3.0);
        }
        let ratio = thumbhash::thumb_hash_to_approximate_aspect_ratio(&hash).expect("ratio");
        assert_close(f64::from(ratio), 600.0 / 900.0, 0.1);
    }
}
