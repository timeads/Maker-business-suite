"use server";

import { headers } from "next/headers";
import { visitorAddress, voteOnHelpArticle } from "@/lib/helpdesk/help-centre-server";

export type HelpfulState = { said?: string };

/**
 * A visitor's yes or no on an article. Anyone can call this, so everything
 * is checked on the way in: the answer is one of two words, the article must
 * be a published one of that workspace, and one visitor counts once.
 */
export async function answerHelpful(
  workspace: string,
  article: string,
  _prev: HelpfulState,
  formData: FormData,
): Promise<HelpfulState> {
  const answer = formData.get("helpful");
  if (answer !== "yes" && answer !== "no") return {};
  const result = await voteOnHelpArticle(
    String(workspace).slice(0, 80),
    String(article).slice(0, 80),
    answer === "yes",
    visitorAddress(await headers()),
  );
  if (result === "gone") return { said: "This article isn't here any more." };
  return {
    said:
      result === "already"
        ? "Thanks, we already have your answer."
        : answer === "yes"
          ? "Thanks for letting us know."
          : "Thanks. We'll use that to make it better.",
  };
}
