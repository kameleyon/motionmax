import { describe, it, expect } from "vitest";
import { thumbnailUrl, gridThumbnailUrl, previewImageUrl } from "../thumbnailUrl";
import { normalizeProjectType } from "../projectUtils";

const SUPABASE_PUBLIC = "https://abc.supabase.co/storage/v1/object/public/images/photo.jpg";
const SIGNED_URL = "https://abc.supabase.co/storage/v1/object/sign/bucket/file.jpg";
const EXTERNAL_URL = "https://cdn.example.com/image.jpg";

describe("thumbnailUrl", () => {
  it("returns null for null/undefined input", () => {
    expect(thumbnailUrl(null)).toBeNull();
    expect(thumbnailUrl(undefined)).toBeNull();
    expect(thumbnailUrl("")).toBeNull();
  });

  it("returns external URLs unchanged", () => {
    expect(thumbnailUrl(EXTERNAL_URL)).toBe(EXTERNAL_URL);
  });

  it("appends transformation params to Supabase public URLs", () => {
    const result = thumbnailUrl(SUPABASE_PUBLIC);
    expect(result).toContain("width=400");
    expect(result).toContain("height=400");
    expect(result).toContain("quality=75");
    expect(result).toContain("format=webp");
  });

  it("respects custom options", () => {
    const result = thumbnailUrl(SUPABASE_PUBLIC, { width: 200, height: 150, quality: 90 });
    expect(result).toContain("width=200");
    expect(result).toContain("height=150");
    expect(result).toContain("quality=90");
  });

  it("does not transform signed URLs", () => {
    const result = thumbnailUrl(SIGNED_URL);
    expect(result).toBe(SIGNED_URL);
  });

  it("omits format param when format=origin", () => {
    const result = thumbnailUrl(SUPABASE_PUBLIC, { format: "origin" });
    expect(result).not.toContain("format=");
  });
});

describe("gridThumbnailUrl", () => {
  it("uses 300x300 at quality 70", () => {
    const result = gridThumbnailUrl(SUPABASE_PUBLIC);
    expect(result).toContain("width=300");
    expect(result).toContain("height=300");
    expect(result).toContain("quality=70");
  });

  it("returns null for null input", () => {
    expect(gridThumbnailUrl(null)).toBeNull();
  });
});

describe("previewImageUrl", () => {
  it("uses 1024x1024 at quality 85", () => {
    const result = previewImageUrl(SUPABASE_PUBLIC);
    expect(result).toContain("width=1024");
    expect(result).toContain("height=1024");
    expect(result).toContain("quality=85");
  });
});

describe("normalizeProjectType", () => {
  it("normalizes 'smart-flow' to 'smartflow'", () => {
    expect(normalizeProjectType("smart-flow")).toBe("smartflow");
  });

  it("returns 'doc2video' for null/undefined", () => {
    expect(normalizeProjectType(null)).toBe("doc2video");
    expect(normalizeProjectType(undefined)).toBe("doc2video");
  });

  it("passes through canonical types unchanged", () => {
    expect(normalizeProjectType("smartflow")).toBe("smartflow");
    expect(normalizeProjectType("cinematic")).toBe("cinematic");
    expect(normalizeProjectType("explainer")).toBe("explainer");
  });
});
