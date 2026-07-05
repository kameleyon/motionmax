import { describe, it, expect } from "vitest";
import { buildImagePrompt, stripOverlayTitleText, type Scene } from "./imagePromptBuilder.js";

const baseOpts = {
  format: "landscape",
  style: "minimalist", // a TEXT_OVERLAY_STYLE — proves cinematic suppresses it
  characterBible: {},
  characterDescription: "",
  isSmartFlow: false,
};

function scene(over: Partial<Scene>): Scene {
  return { duration: 5, ...over } as Scene;
}

describe("buildImagePrompt — cinematic title scoping", () => {
  it("renders the cover title ONLY on the Scene 1 primary image", () => {
    const out = buildImagePrompt(
      "A wide establishing shot",
      scene({ coverTitle: "THE THRONE" }),
      0, // subIndex
      0, // sceneIndex (cover)
      { ...baseOpts, isCinematic: true },
    );
    expect(out).toContain("THE THRONE");
    expect(out).toContain("COVER IMAGE TITLE");
  });

  it("renders NO title text on later cinematic scenes and tells the model to follow THIS scene", () => {
    const out = buildImagePrompt(
      "A close-up of the hero at the docks",
      scene({ title: "Scene Two Headline" }),
      0,
      2, // a later scene
      { ...baseOpts, isCinematic: true },
    );
    expect(out).toContain("NO TITLE");
    // The bug: the per-scene title was being stamped on every scene.
    expect(out).not.toContain('Render "Scene Two Headline"');
    expect(out).not.toContain("COVER IMAGE TITLE");
    // Must still carry the per-scene description (not stuck on scene 1).
    expect(out).toContain("A close-up of the hero at the docks");
  });

  it("keeps the title block within the first 3900 chars so gpt-image-2 truncation can't drop it", () => {
    // A realistically long per-scene description (cinematic temporal-consistency
    // rules routinely push the full prompt past 4000 chars; gpt-image-2
    // head-truncates to 3900, dropping the tail).
    const longVisual = "A sweeping battle scene. ".repeat(80); // ~2000 chars
    const out = buildImagePrompt(
      longVisual,
      scene({ coverTitle: "THE THRONE" }),
      0,
      0,
      { ...baseOpts, isCinematic: true },
    );
    // Title sits in the kept HEAD — before the ~2KB of boilerplate that the
    // truncation drops — so it survives.
    expect(out.indexOf("COVER IMAGE TITLE")).toBeLessThan(out.indexOf("GENERATION REQUIREMENTS"));
    expect(out.indexOf("THE THRONE")).toBeLessThan(3900);
  });

  it("leaves explainer/non-cinematic per-scene text overlays untouched", () => {
    const out = buildImagePrompt(
      "An infographic of the quarterly numbers",
      scene({ title: "Q2 Results" }),
      0,
      3,
      { ...baseOpts, isCinematic: false }, // explainer
    );
    expect(out).toContain('Render "Q2 Results"'); // overlay preserved
    expect(out).not.toContain("NO TITLE");
  });

  it("strips embedded overlay-title text from a later cinematic scene's description", () => {
    const out = buildImagePrompt(
      "'THE JOURNEY BEGINS' in bold typography fading in over morning mist. A woman steps into frame, coat billowing.",
      scene({ title: "whatever" }),
      0,
      1, // later scene
      { ...baseOpts, isCinematic: true },
    );
    expect(out).not.toContain("THE JOURNEY BEGINS");
    expect(out).not.toContain("typography");
    // The real visual content survives.
    expect(out).toContain("A woman steps into frame, coat billowing.");
  });
});

describe("stripOverlayTitleText", () => {
  it("removes a quoted-title + typography lead-in", () => {
    expect(
      stripOverlayTitleText("'RISE TO POWER' in bold typography fading in. A castle on a cliff."),
    ).toBe("A castle on a cliff.");
  });

  it("removes explicit text-overlay / title-card directives", () => {
    expect(stripOverlayTitleText("Text overlay: The End. A sunset over the ocean.")).toBe(
      "A sunset over the ocean.",
    );
  });

  it('removes "the words … appear" overlay clauses', () => {
    expect(
      stripOverlayTitleText('The words "GAME OVER" appear on screen. A player drops the controller.'),
    ).toBe("A player drops the controller.");
  });

  it("leaves a normal description (no overlay text) unchanged", () => {
    const clean = "A weathered ship glides into a 1900s harbor at dawn, immigrants crowding the rails.";
    expect(stripOverlayTitleText(clean)).toBe(clean);
  });

  it("leaves diegetic signage (a sign reading X) intact", () => {
    const diegetic = "A storefront with a wooden sign reading 'BAKERY' above the door, warm light inside.";
    expect(stripOverlayTitleText(diegetic)).toBe(diegetic);
  });
});
