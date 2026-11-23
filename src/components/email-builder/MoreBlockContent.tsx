"use client";

/* eslint-disable @next/next/no-img-element -- pictures in an email sit on other hosts, at addresses not known ahead of time */

import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickLogo } from "@/lib/design/brands";
import {
  SOCIAL_NETWORKS,
  findBlock,
  logoLook,
  safeHref,
  safeUrl,
  videoThumbnail,
  type LogoBlock,
  type SocialBlock,
  type SocialLink,
  type SocialNetwork,
  type VideoBlock,
} from "@/lib/design";
import { useBuilder } from "./context";
import { useHost } from "./host";
import { DeviceCard, ImageField, NumberField, Segmented, SelectField, TextField } from "./fields";

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="text-muted-foreground text-xs leading-relaxed">{children}</p>
);
const NETWORKS = Object.keys(SOCIAL_NETWORKS) as SocialNetwork[];

/** The brand's social accounts: which ones, their addresses, their order, and whether they show as plain links or outlined names. */
export function SocialContent({ block }: { block: SocialBlock }) {
  const { dispatch } = useBuilder();
  const set = (patch: Record<string, unknown>) =>
    dispatch({ type: "updateBlock", id: block.id, patch });
  const links = (next: SocialLink[]) => set({ links: next });
  const unused = NETWORKS.filter((n) => !block.links.some((l) => l.network === n));
  const move = (i: number, by: -1 | 1) => {
    const next = [...block.links];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    links(next);
  };
  return (
    <div className="space-y-4">
      <Segmented
        label="Shown as"
        value={block.look}
        options={[
          { value: "links", label: "Links" },
          { value: "pills", label: "Outlined" },
        ]}
        onChange={(look) => set({ look })}
      />
      <ul className="space-y-2" aria-label="Accounts">
        {block.links.map((l, i) => (
          <li
            key={l.network}
            className="border-border space-y-1 rounded-md border p-2"
            data-social={l.network}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-medium">{SOCIAL_NETWORKS[l.network]}</span>
              <span className="flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 px-0"
                  aria-label={`Move ${SOCIAL_NETWORKS[l.network]} up`}
                  title="Move up"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 px-0"
                  aria-label={`Move ${SOCIAL_NETWORKS[l.network]} down`}
                  title="Move down"
                  disabled={i === block.links.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 px-0"
                  aria-label={`Remove ${SOCIAL_NETWORKS[l.network]}`}
                  title="Remove"
                  onClick={() => links(block.links.filter((_, n) => n !== i))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </span>
            </div>
            <Input
              className="h-8 text-xs"
              aria-label={`${SOCIAL_NETWORKS[l.network]} address`}
              value={l.url}
              placeholder="https://"
              inputMode="url"
              onChange={(e) =>
                links(block.links.map((x, n) => (n === i ? { ...x, url: e.target.value } : x)))
              }
            />
            {l.url && !safeUrl(l.url) && (
              <span className="text-muted-foreground block text-[11px]">
                The address must start with https://
              </span>
            )}
          </li>
        ))}
      </ul>
      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Add an account">
          {unused.map((n) => (
            <Button
              key={n}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => links([...block.links, { network: n, url: "" }])}
            >
              <Plus className="h-3 w-3" />
              {SOCIAL_NETWORKS[n]}
            </Button>
          ))}
        </div>
      )}
      <NumberField
        label="Text size"
        value={block.styles.size ?? 14}
        min={10}
        max={30}
        onChange={(size) => dispatch({ type: "updateBlockStyles", id: block.id, patch: { size } })}
      />
      <Note>
        Accounts are shown by name, as words, so nothing depends on little pictures loading. One
        with no address is left out.
      </Note>
    </div>
  );
}

/** A video, shown in the email as a still picture with a play mark that opens it. */
export function VideoContent({ block }: { block: VideoBlock }) {
  const { dispatch } = useBuilder();
  const set = (patch: Record<string, unknown>) =>
    dispatch({ type: "updateBlock", id: block.id, patch });
  // YouTube's own still can be told from the address. For anywhere else a picture is chosen by hand.
  const suggested = videoThumbnail(block.url);
  return (
    <div className="space-y-4">
      <TextField
        label="Video address"
        value={block.url}
        placeholder="https://www.youtube.com/watch?v=..."
        inputMode="url"
        onChange={(url) =>
          set(
            !block.thumbnail && videoThumbnail(url)
              ? { url, thumbnail: videoThumbnail(url) }
              : { url },
          )
        }
        hint={
          block.url && !safeUrl(block.url)
            ? "The address must start with https://"
            : "Where the video is: YouTube, Vimeo or anywhere else on the web."
        }
      />
      <ImageField
        label="Still picture"
        value={block.thumbnail}
        onChange={(thumbnail) => set({ thumbnail })}
        hint="Email cannot play video, so this picture is shown with a play mark, and opens the video when clicked."
      />
      {suggested && suggested !== block.thumbnail && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set({ thumbnail: suggested })}
        >
          <Sparkles className="h-3.5 w-3.5" /> Use YouTube&apos;s own picture
        </Button>
      )}
      {block.url && !suggested && !block.thumbnail && (
        <Note>For videos that are not on YouTube, choose a still picture from your library.</Note>
      )}
      <TextField
        label="Words under the video"
        value={block.alt}
        placeholder="Watch the video"
        onChange={(alt) => set({ alt })}
        hint="Also read out to people who cannot see the picture."
      />
    </div>
  );
}

/** The brand's logo: which picture, how wide on a computer and on a phone, and where it links. */
export function LogoContent({ block }: { block: LogoBlock }) {
  const { doc, dispatch } = useBuilder();
  const set = (patch: Record<string, unknown>) =>
    dispatch({ type: "updateBlock", id: block.id, patch });
  const { logos } = useHost();
  const look = logoLook(doc, block);
  // The colour the logo sits on decides which of the brand's logos reads on it.
  const found = findBlock(doc, block.id);
  const behind =
    block.styles.background ?? found?.section.styles.contentBg ?? doc.globalStyles.contentBg;
  const suited = pickLogo(behind, logos, doc.brand);
  const choices: { value: string; label: string }[] = [
    { value: "", label: "The email's logo" },
    ...(logos.badge ? [{ value: logos.badge, label: "Badge, in full colour" }] : []),
    ...(logos.dark ? [{ value: logos.dark, label: "Mark, for light backgrounds" }] : []),
    ...(logos.light ? [{ value: logos.light, label: "Mark, for dark backgrounds" }] : []),
    ...(block.src && ![logos.badge, logos.dark, logos.light].includes(block.src)
      ? [{ value: block.src, label: "A picture you chose" }]
      : []),
  ];
  return (
    <div className="space-y-4">
      {look.src && (
        <img
          src={look.src}
          alt=""
          className="bg-sunken border-border max-h-24 w-full rounded border object-contain"
        />
      )}
      <SelectField
        label="Which logo"
        value={block.src}
        options={choices}
        onChange={(src) => set({ src })}
      />
      {suited && suited !== look.src && (
        <Button type="button" variant="outline" size="sm" onClick={() => set({ src: suited })}>
          <Sparkles className="h-3.5 w-3.5" /> Use the logo that suits this background
        </Button>
      )}
      <ImageField
        label="Or another picture"
        value={block.src}
        onChange={(src) => set({ src })}
        hint={
          block.src
            ? undefined
            : "Left as it is, the block shows the email's logo, set under Styles, then Logo."
        }
      />
      <DeviceCard
        same={block.styles.sameForMobile}
        onSame={(sameForMobile) =>
          dispatch({ type: "updateBlockStyles", id: block.id, patch: { sameForMobile } })
        }
      >
        {(device) =>
          device === "desktop" ? (
            <NumberField
              label="Width"
              value={block.width}
              min={24}
              max={600}
              onChange={(width) => set({ width })}
            />
          ) : (
            <NumberField
              label="Width"
              value={block.mobileWidth}
              min={24}
              max={375}
              onChange={(mobileWidth) => set({ mobileWidth })}
            />
          )
        }
      </DeviceCard>
      <TextField
        label="Link when clicked"
        value={block.link}
        placeholder={doc.globalStyles.logo.link}
        inputMode="url"
        onChange={(link) => set({ link })}
        hint={
          block.link && !safeHref(block.link)
            ? "Links must start with https://"
            : "Left empty, it uses the email's logo link."
        }
      />
      <TextField
        label="What the picture shows"
        value={block.alt}
        onChange={(alt) => set({ alt })}
        hint="Read out to people who cannot see the picture."
      />
    </div>
  );
}
