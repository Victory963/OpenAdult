import { describe, expect, it, vi } from "vitest";
import { buildChatSystemPrompt, UserPreferenceContext } from "./llm-prompts";

describe("Chat AI Preference Integration", () => {
  it("should build system prompt without user context", () => {
    const prompt = buildChatSystemPrompt("ja");
    expect(prompt).toContain("adult video search assistant");
    expect(prompt).toContain("日本語で回答してください");
    expect(prompt).not.toContain("USER PREFERENCE CONTEXT");
  });

  it("should build system prompt with user context", () => {
    const context: UserPreferenceContext = {
      topKeywords: [
        { keyword: "熟女", count: 5 },
        { keyword: "巨乳", count: 3 },
      ],
      topCategories: [
        { category: "熟女", count: 4 },
      ],
      favoriteActresses: [
        { id: 1, name: "佐々木あき", profileImageUrl: null },
      ],
      recentSearches: ["熟女 中出し", "巨乳 新作"],
      watchedCategories: [
        { category: "中出し", count: 6 },
        { category: "熟女", count: 4 },
      ],
      relevantVideos: [
        { id: 90001, title: "テスト動画", category: "熟女", rating: "4.5" },
      ],
      relevantActresses: [
        { id: 1, name: "佐々木あき", profileImageUrl: null },
      ],
    };

    const prompt = buildChatSystemPrompt("ja", context);
    expect(prompt).toContain("USER PREFERENCE CONTEXT");
    expect(prompt).toContain("熟女(5)");
    expect(prompt).toContain("巨乳(3)");
    expect(prompt).toContain("佐々木あき");
    expect(prompt).toContain("熟女 中出し");
    expect(prompt).toContain("[ID:90001] テスト動画");
    expect(prompt).toContain("中出し(6)");
  });

  it("should build system prompt in Chinese", () => {
    const prompt = buildChatSystemPrompt("zh");
    expect(prompt).toContain("用中文回答");
  });

  it("should build system prompt in English", () => {
    const prompt = buildChatSystemPrompt("en");
    expect(prompt).toContain("respond in English");
  });

  it("should handle empty user context gracefully", () => {
    const context: UserPreferenceContext = {
      topKeywords: [],
      topCategories: [],
      favoriteActresses: [],
      recentSearches: [],
      watchedCategories: [],
    };

    const prompt = buildChatSystemPrompt("ja", context);
    // Empty context should not add the context section
    expect(prompt).not.toContain("USER PREFERENCE CONTEXT");
  });

  it("should include relevant videos in context when provided", () => {
    const context: UserPreferenceContext = {
      topKeywords: [],
      topCategories: [],
      favoriteActresses: [],
      recentSearches: [],
      watchedCategories: [],
      relevantVideos: [
        { id: 1, title: "動画A", category: "巨乳", rating: "4.2" },
        { id: 2, title: "動画B", category: null, rating: null },
      ],
    };

    const prompt = buildChatSystemPrompt("ja", context);
    expect(prompt).toContain("USER PREFERENCE CONTEXT");
    expect(prompt).toContain("[ID:1] 動画A");
    expect(prompt).toContain("(巨乳, rating: 4.2)");
    expect(prompt).toContain("[ID:2] 動画B");
    expect(prompt).toContain("(uncategorized, rating: N/A)");
  });
});
