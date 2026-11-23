"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  ImageIcon,
  Plus,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Switch, Textarea } from "@/components/email-builder/ui";
import {
  MAX_DESIGN_SLIDES,
  POST_FORMATS,
  inkOn,
  kitSwatches,
  nextSlideFor,
  relayoutIn,
  withPhotoIn,
  withoutPicIn,
} from "@/lib/brand/slides";
import type { BrandKit, LayoutId } from "@/lib/design/brands";
import type { Issue } from "@/lib/design/slide-check";
import {
  FORMATS,
  canvasFont,
  drawSlide,
  layoutLayer,
  newId,
  newTextLayer,
  type DrawableImage,
  type LayerBox,
  type Plate,
  type Slide,
  type SlideDesign,
  type SlideFont,
  type SlideFormat,
  type TextLayer,
} from "@/lib/design/slide-design";
import { layoutsFor, recolor, schemeFor } from "@/lib/design/slide-layouts";
import {
  SLIDE_FONT_NAMES,
  checkSlideMeasured,
  ensureSlideFonts,
  fitDesign,
  fitSlideMeasured,
  fontResolverFor,
  loadSlideImages,
} from "@/lib/design/slide-render";
import { cn } from "@/lib/utils";
import { SlidePhotoPicker, type StudioPhoto } from "./SlidePhotoPicker";

interface SlideStudioProps {
  design: SlideDesign;
  onChange: (design: SlideDesign) => void;
  /** The workspace's kit: every colour, layout and typeface offered comes from it. */
  kit: BrandKit;
  /** The workspace's photos, read when the photo picker is opened. */
  loadPhotos: () => Promise<StudioPhoto[]>;
  /** Editing one picture (an email banner): no slide strip, and its shape is fixed. */
  single?: boolean;
}

/** Paints one slide at the given width. Used for the stage and the thumbnails. */
function SlidePreview({
  slide,
  format,
  kit,
  width,
  onPainted,
}: {
  slide: Slide;
  format: SlideFormat;
  kit: BrandKit;
  width: number;
  /** Called once the real typefaces and photos are in, with how many photos could not be loaded. */
  onPainted?: (missing: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { w, h } = FORMATS[format];
  const height = Math.round((width * h) / w);

  useEffect(() => {
    let cancelled = false;
    const canvas = ref.current;
    if (!canvas || width <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const paint = (
      image: HTMLImageElement | null,
      pics: Record<string, DrawableImage | null>,
    ): boolean => {
      if (cancelled) return false;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSlide(ctx, slide, width, height, image, fontResolverFor(kit), pics);
      return true;
    };
    // Straight away in whatever is to hand, then again once the typefaces and photos have arrived.
    paint(null, {});
    (async () => {
      await ensureSlideFonts(slide, kit);
      const loaded = await loadSlideImages(slide);
      if (paint(loaded.image, loaded.pics)) onPainted?.(loaded.missing);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slide, kit, width, height, onPainted]);

  return <canvas ref={ref} style={{ width, height }} className="block rounded-md" />;
}

let measuring: HTMLCanvasElement | null = null;
/** Where a text sits on the stage, measured in its real typeface. */
function layerBox(layer: TextLayer, W: number, H: number, kit: BrandKit): LayerBox | null {
  if (typeof document === "undefined") return null;
  measuring ??= document.createElement("canvas");
  const ctx = measuring.getContext("2d");
  if (!ctx) return null;
  ctx.font = canvasFont(layer, (layer.size * W) / 1080, fontResolverFor(kit));
  return layoutLayer(layer, W, H, (t) => ctx.measureText(t).width);
}

function ColorRow({
  value,
  onChange,
  id,
  kit,
}: {
  value: string;
  onChange: (hex: string) => void;
  id: string;
  kit: BrandKit;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {kitSwatches(kit).map((c) => (
        <button
          key={c.name}
          type="button"
          title={c.name}
          aria-label={c.name}
          aria-pressed={value.toLowerCase() === c.hex}
          onClick={() => onChange(c.hex)}
          className={cn(
            "size-6 rounded-full border transition-transform hover:scale-110",
            value.toLowerCase() === c.hex
              ? "ring-ochre ring-offset-card ring-2 ring-offset-2"
              : "border-border",
          )}
          style={{ background: c.hex }}
        />
      ))}
      <input
        id={id}
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Another colour"
        className="border-border h-6 w-8 cursor-pointer rounded border bg-transparent p-0"
      />
    </div>
  );
}

function Range({
  label,
  shown,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  shown?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between">
        <Label htmlFor={id}>{label}</Label>
        {shown !== undefined && (
          <span className="text-muted-foreground text-xs tabular-nums">{shown}</span>
        )}
      </div>
      <input
        id={id}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-teal w-full"
      />
    </div>
  );
}

const iconButton = "w-[30px] px-0";
const FONT_CHOICES: SlideFont[] = ["display", "body", "label", "hand"];
const ALIGNS = [
  ["left", AlignLeft],
  ["center", AlignCenter],
  ["right", AlignRight],
] as const;

type PhotoTarget = "fill" | "new" | { pic: string };

/**
 * The designer: one picture or several, each made of text and photos that stay editable. It
 * only changes the design it is given; drawing the finished pictures and keeping them is up to
 * whoever opened it.
 */
export function SlideStudio({
  design,
  onChange,
  kit,
  loadPhotos,
  single = false,
}: SlideStudioProps) {
  const [slideIndex, setSlideIndex] = useState(0);
  const [layerId, setLayerId] = useState<string | null>(null);
  const [stageWidth, setStageWidth] = useState(360);
  // Counted up each time the stage is drawn in its real typefaces, so the text boxes are measured again.
  const [painted, setPainted] = useState(0);
  const [missing, setMissing] = useState(0);
  // Where a chosen photo goes: behind the whole slide, into one frame, or into a new frame.
  const [picking, setPicking] = useState<PhotoTarget | null>(null);
  const [guide, setGuide] = useState(false);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    layer: TextLayer;
  } | null>(null);
  const ids = useId();

  const index = Math.min(slideIndex, design.slides.length - 1);
  const slide = design.slides[index];
  const layer = slide.layers.find((l) => l.id === layerId) ?? null;
  const { w: fw, h: fh } = FORMATS[design.format];
  const stageHeight = Math.round((stageWidth * fh) / fw);
  const scheme = schemeFor(slide.bg, kit);
  const layouts = layoutsFor(kit);

  useEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;
    // The observer reports the size once when it starts, and again whenever it changes.
    const ro = new ResizeObserver(() =>
      setStageWidth(Math.max(220, Math.min(el.clientWidth, 560))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const updateSlide = useCallback(
    (patch: Partial<Slide> | ((s: Slide) => Slide)) => {
      onChange({
        ...design,
        slides: design.slides.map((s, i) =>
          i === index ? (typeof patch === "function" ? patch(s) : { ...s, ...patch }) : s,
        ),
      });
    },
    [design, index, onChange],
  );

  const updateLayer = useCallback(
    (id: string, patch: Partial<TextLayer>) => {
      updateSlide((s) => ({
        ...s,
        layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      }));
    },
    [updateSlide],
  );

  const boxes = useMemo(
    () =>
      // `painted` is read so the boxes are measured again once the real typefaces are in.
      (painted >= 0 ? slide.layers : []).flatMap((l) => {
        const box = layerBox(l, stageWidth, stageHeight, kit);
        return box ? [{ layer: l, box }] : [];
      }),
    [slide.layers, kit, stageWidth, stageHeight, painted],
  );

  const onPainted = useCallback((lost: number) => {
    setPainted((n) => n + 1);
    setMissing(lost);
  }, []);

  // A slide straight from a layout is measured in its real typeface and put right once, before
  // anyone sees it: no cut-off or overlapping text. Slides already checked are left alone.
  useEffect(() => {
    if (!design.slides.some((s) => s.layout && !s.fit)) return;
    let live = true;
    fitDesign(design, kit)
      .then((fitted) => {
        if (live && fitted !== design) onChange(fitted);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Only a new design needs fitting, not a new `onChange` from the page around it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, kit]);

  // What is wrong with the slide on screen, if anything, checked as it is edited.
  const [issues, setIssues] = useState<Issue[]>([]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      checkSlideMeasured(slide, design.format, kit)
        .then((found) => {
          if (live) setIssues(found);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [slide, design.format, kit, painted]);
  const fixIssues = async () => {
    const fixed = await fitSlideMeasured(slide, design.format, kit);
    updateSlide(() => fixed);
    setLayerId(null);
  };

  const startDrag = (e: React.PointerEvent, l: TextLayer, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, layer: l };
    setLayerId(l.id);
  };

  const onDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = ((e.clientX - drag.startX) / stageWidth) * 100;
    const dy = ((e.clientY - drag.startY) / stageHeight) * 100;
    const l = drag.layer;
    if (drag.mode === "resize") {
      updateLayer(l.id, {
        w: Math.round(Math.min(100 - l.x, Math.max(10, l.w + dx)) * 10) / 10,
      });
      return;
    }
    let x = Math.min(100 - l.w, Math.max(0, l.x + dx));
    const y = Math.min(98, Math.max(0, l.y + dy));
    const centred = Math.abs(x + l.w / 2 - 50) < 1.2;
    if (centred) x = 50 - l.w / 2;
    setGuide(centred);
    updateLayer(l.id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  };

  const endDrag = () => {
    dragRef.current = null;
    setGuide(false);
  };

  /** Arrow keys move the selected text, for anyone not using a pointer. */
  const nudge = (e: React.KeyboardEvent, l: TextLayer) => {
    const by = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      e.key
    ];
    if (e.key === "Enter") return setLayerId(l.id);
    if (!by) return;
    e.preventDefault();
    setLayerId(l.id);
    updateLayer(l.id, {
      x: Math.min(100 - l.w, Math.max(0, l.x + by[0])),
      y: Math.min(98, Math.max(0, l.y + by[1])),
    });
  };

  const full = design.slides.length >= MAX_DESIGN_SLIDES;
  const insertAfter = (next: Slide) => {
    onChange({
      ...design,
      slides: [...design.slides.slice(0, index + 1), next, ...design.slides.slice(index + 1)],
    });
    setSlideIndex(index + 1);
    setLayerId(null);
  };
  const addSlide = () => insertAfter(nextSlideFor(kit, slide, design.format));
  const duplicateSlide = () =>
    insertAfter({
      ...slide,
      id: newId("s"),
      layers: slide.layers.map((l) => ({ ...l, id: newId("l") })),
      pics: slide.pics.map((p) => ({ ...p, id: newId("p") })),
    });

  const deleteSlide = () => {
    if (design.slides.length <= 1) return;
    onChange({ ...design, slides: design.slides.filter((_, i) => i !== index) });
    setSlideIndex(Math.max(0, index - 1));
    setLayerId(null);
  };

  const moveSlide = (dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= design.slides.length) return;
    const slides = [...design.slides];
    const [item] = slides.splice(index, 1);
    slides.splice(to, 0, item);
    onChange({ ...design, slides });
    setSlideIndex(to);
  };

  const addText = () => {
    // Drop the new text under whatever is lowest on the slide so it never lands on top of other text.
    const lowest = boxes.reduce(
      (max, { box }) => Math.max(max, ((box.y + box.h) / stageHeight) * 100),
      0,
    );
    const l: TextLayer = {
      ...newTextLayer(slide),
      color: inkOn(kit, slide),
      y: Math.round(Math.min(88, boxes.length ? lowest + 3 : 20) * 10) / 10,
    };
    updateSlide((s) => ({ ...s, layers: [...s.layers, l] }));
    setLayerId(l.id);
    setTimeout(() => textRef.current?.select(), 0);
  };

  /** Put a chosen photo where the open picker was asked to put it. */
  const placePhoto = (url: string) => {
    const target = picking ?? "new";
    setPicking(null);
    if (target === "new") {
      updateSlide((s) => withPhotoIn(kit, s, url, design.format));
      setLayerId(null);
    } else if (target === "fill") {
      updateSlide((s) => ({
        ...s,
        image: url,
        imageDim: s.image ? s.imageDim : 0.35,
        // Words that were in the background's own text colour turn white to read over the photo.
        layers: s.image
          ? s.layers
          : s.layers.map((l) =>
              !l.plate && l.color === schemeFor(s.bg, kit).ink ? { ...l, color: "#ffffff" } : l,
            ),
      }));
    } else {
      updateSlide((s) => ({
        ...s,
        pics: s.pics.map((p) => (p.id === target.pic ? { ...p, url } : p)),
      }));
    }
  };

  const deleteLayer = (id: string) => {
    updateSlide((s) => ({ ...s, layers: s.layers.filter((l) => l.id !== id) }));
    setLayerId(null);
  };

  /** Another shape for every slide. Their text is measured afresh for the new room. */
  const reshape = (format: SlideFormat) =>
    onChange({
      ...design,
      format,
      slides: design.slides.map(({ fit: _fit, ...s }) => s),
    });

  const fonts = layer && !FONT_CHOICES.includes(layer.font) ? [...FONT_CHOICES, layer.font] : null;

  return (
    <div className="space-y-4">
      {/* The slides, in order */}
      {!single && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {design.slides.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSlideIndex(i);
                setLayerId(null);
              }}
              aria-label={`Picture ${i + 1}`}
              aria-current={i === index}
              className={cn(
                "relative shrink-0 rounded-md border-2 transition-colors",
                i === index ? "border-ochre" : "hover:border-border border-transparent",
              )}
            >
              <SlidePreview slide={s} format={design.format} kit={kit} width={64} />
              <span className="bg-card/85 absolute top-1 left-1 rounded px-1 text-[10px] font-medium tabular-nums">
                {i + 1}
              </span>
            </button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={addSlide}
            disabled={full}
            title={full ? "A post can hold up to ten pictures" : undefined}
          >
            <Plus aria-hidden /> Another picture
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
        {/* The picture itself */}
        <div className="min-w-0 space-y-2">
          <div ref={stageWrapRef} className="w-full">
            <div
              className="bg-sunken border-border relative mx-auto overflow-hidden rounded-md border select-none"
              style={{ width: stageWidth, height: stageHeight }}
              onPointerDown={() => setLayerId(null)}
            >
              <SlidePreview
                slide={slide}
                format={design.format}
                kit={kit}
                width={stageWidth}
                onPainted={onPainted}
              />
              {guide && (
                <div className="bg-ochre pointer-events-none absolute inset-y-0 left-1/2 w-px" />
              )}
              {boxes.map(({ layer: l, box }) => {
                const selected = l.id === layerId;
                return (
                  <div
                    key={l.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Text: ${l.text.slice(0, 40)}`}
                    aria-pressed={selected}
                    onPointerDown={(e) => startDrag(e, l, "move")}
                    onPointerMove={onDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onDoubleClick={() => textRef.current?.select()}
                    onKeyDown={(e) => nudge(e, l)}
                    className={cn(
                      "outline-ochre absolute cursor-move touch-none rounded-sm outline-offset-2",
                      selected ? "outline-2" : "hover:outline-1 focus-visible:outline-1",
                    )}
                    style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                  >
                    {selected && (
                      <span
                        onPointerDown={(e) => startDrag(e, l, "resize")}
                        onPointerMove={onDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        title="Drag to make the text wider or narrower"
                        className="border-ochre bg-card absolute top-1/2 -right-2 h-5 w-3 -translate-y-1/2 cursor-ew-resize touch-none rounded-sm border"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {missing > 0 && (
            <p role="alert" className="bg-brick-soft rounded-sm px-3 py-2 text-xs">
              {missing === 1 ? "A photo" : "Some photos"} in this design couldn&apos;t be loaded, so{" "}
              {missing === 1 ? "it is" : "they are"} left blank here. Replace{" "}
              {missing === 1 ? "it" : "them"} from your assets before you save.
            </p>
          )}
          {!single && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={iconButton}
                  onClick={() => moveSlide(-1)}
                  disabled={index === 0}
                  aria-label="Move this picture earlier"
                >
                  <ChevronLeft aria-hidden />
                </Button>
                <span className="text-muted-foreground text-xs tabular-nums">
                  Picture {index + 1} of {design.slides.length}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={iconButton}
                  onClick={() => moveSlide(1)}
                  disabled={index === design.slides.length - 1}
                  aria-label="Move this picture later"
                >
                  <ChevronRight aria-hidden />
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={duplicateSlide}
                  disabled={full}
                >
                  <Copy aria-hidden /> Copy it
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={deleteSlide}
                  disabled={design.slides.length <= 1}
                >
                  <Trash2 aria-hidden /> Delete
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* What can be changed */}
        <div className="min-w-0 space-y-4">
          {issues.length > 0 && (
            <div role="status" className="bg-brick-soft space-y-2 rounded-md p-3 text-xs">
              <p className="font-bold">This picture needs a look</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {[...new Set(issues.map((i) => i.text))].slice(0, 4).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <Button type="button" size="sm" variant="outline" onClick={fixIssues}>
                Fix it for me
              </Button>
            </div>
          )}
          {layer ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold">Text</h4>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteLayer(layer.id)}
                  >
                    <Trash2 aria-hidden /> Remove
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={iconButton}
                    onClick={() => setLayerId(null)}
                    aria-label="Done with this text"
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              </div>
              <Textarea
                ref={textRef}
                aria-label="The words"
                value={layer.text}
                onChange={(e) => updateLayer(layer.id, { text: e.target.value })}
                className="font-read min-h-[90px] resize-y"
                placeholder="Your words…"
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}font`}>Lettering</Label>
                  <Select
                    id={`${ids}font`}
                    value={layer.font}
                    onChange={(e) => updateLayer(layer.id, { font: e.target.value as SlideFont })}
                  >
                    {(fonts ?? FONT_CHOICES).map((f) => (
                      <option key={f} value={f}>
                        {SLIDE_FONT_NAMES[f]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}weight`}>Weight</Label>
                  <Select
                    id={`${ids}weight`}
                    value={String(layer.weight)}
                    onChange={(e) =>
                      updateLayer(layer.id, {
                        weight: Number(e.target.value) as TextLayer["weight"],
                      })
                    }
                  >
                    <option value="400">Regular</option>
                    <option value="600">Semibold</option>
                    <option value="700">Bold</option>
                    <option value="800">Heavy</option>
                  </Select>
                </div>
              </div>
              <Range
                label="Size"
                shown={String(Math.round(layer.size))}
                value={layer.size}
                min={16}
                max={240}
                step={2}
                onChange={(size) => updateLayer(layer.id, { size })}
              />
              <Range
                label="Line spacing"
                shown={layer.lineHeight.toFixed(2)}
                value={layer.lineHeight}
                min={0.9}
                max={2}
                step={0.05}
                onChange={(lineHeight) => updateLayer(layer.id, { lineHeight })}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1">
                  {ALIGNS.map(([align, Icon]) => (
                    <Button
                      key={align}
                      type="button"
                      variant={layer.align === align ? "dark" : "outline"}
                      size="sm"
                      className={iconButton}
                      aria-pressed={layer.align === align}
                      aria-label={`Line up ${align === "center" ? "in the middle" : `on the ${align}`}`}
                      onClick={() => updateLayer(layer.id, { align })}
                    >
                      <Icon aria-hidden />
                    </Button>
                  ))}
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <Switch
                    checked={layer.uppercase}
                    onCheckedChange={(uppercase) => updateLayer(layer.id, { uppercase })}
                  />
                  All capitals
                </label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}ink`}>Colour</Label>
                <ColorRow
                  kit={kit}
                  id={`${ids}ink`}
                  value={layer.color}
                  onChange={(hex) => updateLayer(layer.id, { color: hex })}
                />
              </div>
              <div className="grid grid-cols-2 items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}plate`}>Shape behind</Label>
                  <Select
                    id={`${ids}plate`}
                    value={layer.plate ?? "none"}
                    onChange={(e) => {
                      const plate = e.target.value as Plate;
                      updateLayer(
                        layer.id,
                        plate === "none"
                          ? { plate: undefined, plateColor: undefined }
                          : {
                              plate,
                              plateColor: layer.plateColor ?? scheme.accent,
                              ...(layer.plate ? {} : { color: scheme.onAccent }),
                            },
                      );
                    }}
                  >
                    <option value="none">None</option>
                    <option value="pill">Pill (a tag)</option>
                    <option value="burst">Burst (a sticker)</option>
                    <option value="circle">Circle</option>
                  </Select>
                </div>
                {kit.underline && (
                  <label className="flex cursor-pointer items-center gap-2 pb-2 text-xs">
                    <Switch
                      checked={!!layer.scribble}
                      onCheckedChange={(on) =>
                        updateLayer(layer.id, { scribble: on ? scheme.accent : undefined })
                      }
                    />
                    {kit.underline === "scribble" ? "Hand-drawn underline" : "Underline bar"}
                  </label>
                )}
              </div>
              {layer.plate && layer.plate !== "none" && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}platecolor`}>Shape colour</Label>
                  <ColorRow
                    kit={kit}
                    id={`${ids}platecolor`}
                    value={layer.plateColor ?? scheme.accent}
                    onChange={(hex) => updateLayer(layer.id, { plateColor: hex })}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold">
                  {single ? "This picture" : `Picture ${index + 1}`}
                </h4>
                <Button type="button" variant="outline" size="sm" onClick={addText}>
                  <Type aria-hidden /> Add text
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Click any text on the picture to change it. Drag to move it, or drag its right edge
                to make it wider or narrower.
              </p>
              {!single && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}shape`}>Shape</Label>
                  <Select
                    id={`${ids}shape`}
                    value={design.format}
                    onChange={(e) => reshape(e.target.value as SlideFormat)}
                  >
                    {POST_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {FORMATS[f].label}
                      </option>
                    ))}
                  </Select>
                  <p className="text-muted-foreground text-[11px]">
                    Every picture in this post has the same shape.
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}layout`}>Layout</Label>
                <Select
                  id={`${ids}layout`}
                  value={layouts.some((l) => l.id === slide.layout) ? slide.layout : ""}
                  onChange={(e) => {
                    const layout = e.target.value as LayoutId;
                    if (!layout) return;
                    updateSlide((sl) => relayoutIn(kit, sl, layout, design.format));
                    setLayerId(null);
                  }}
                >
                  <option value="">Placed by hand</option>
                  {layouts.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
                <p className="text-muted-foreground text-[11px]">
                  {layouts.find((l) => l.id === slide.layout)?.use ??
                    "Pick a layout to arrange the words and photos in your brand's style."}{" "}
                  Choosing one arranges the picture again.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}bg`}>Colour</Label>
                <ColorRow
                  kit={kit}
                  id={`${ids}bg`}
                  value={slide.bg}
                  onChange={(hex) => updateSlide((sl) => recolor(sl, hex, kit))}
                />
              </div>
              {(kit.grid || kit.wave) && (
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {kit.grid && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs">
                      <Switch
                        checked={!!slide.grid}
                        onCheckedChange={(on) => updateSlide({ grid: on ? scheme.ink : null })}
                      />
                      {kit.grid === "ruled" ? "Ruled grid" : "Hand-drawn grid"}
                    </label>
                  )}
                  {kit.wave && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs">
                      <Switch
                        checked={!!slide.wave}
                        onCheckedChange={(on) => updateSlide({ wave: on ? scheme.accent : null })}
                      />
                      Wave
                    </label>
                  )}
                </div>
              )}
              <div className="space-y-2">
                <p className="text-xs leading-tight font-semibold">Photos</p>
                {slide.pics.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- an upload in the workspace's own storage */}
                    <img
                      crossOrigin="anonymous"
                      src={p.url}
                      alt=""
                      className="border-border size-10 shrink-0 rounded border object-cover"
                    />
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                      {p.contain ? "Logo" : `Photo ${i + 1}`}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPicking({ pic: p.id })}
                    >
                      Swap
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={iconButton}
                      aria-label={`Take ${p.contain ? "the logo" : `photo ${i + 1}`} off`}
                      onClick={() =>
                        updateSlide((sl) => withoutPicIn(kit, sl, p.id, design.format))
                      }
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                ))}
                {slide.pics.length === 1 && !slide.pics[0].contain && (
                  <Range
                    label="Which part of the photo shows"
                    value={slide.pics[0].focusY}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(focusY) =>
                      updateSlide((sl) => ({
                        ...sl,
                        pics: sl.pics.map((x, k) => (k === 0 ? { ...x, focusY } : x)),
                      }))
                    }
                  />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPicking("new")}
                  >
                    <ImageIcon aria-hidden /> Add a photo
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPicking("fill")}
                  >
                    {slide.image ? "Swap the photo behind" : "Photo behind everything"}
                  </Button>
                  {slide.image && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => updateSlide({ image: null, imageDim: 0 })}
                    >
                      Take the photo behind away
                    </Button>
                  )}
                </div>
              </div>
              {slide.image && (
                <>
                  <Range
                    label="Darken the photo"
                    shown={`${Math.round(slide.imageDim * 100)}%`}
                    value={slide.imageDim}
                    min={0}
                    max={0.85}
                    step={0.05}
                    onChange={(imageDim) => updateSlide({ imageDim })}
                  />
                  <Range
                    label="Which part of the photo shows"
                    value={slide.imageY}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(imageY) => updateSlide({ imageY })}
                  />
                </>
              )}
              {slide.layers.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs leading-tight font-semibold">Text on this picture</p>
                  <div className="space-y-1">
                    {slide.layers.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => {
                          setLayerId(l.id);
                          setTimeout(() => textRef.current?.focus(), 0);
                        }}
                        className="hover:bg-hover border-border font-read block w-full truncate rounded-md border px-2 py-1.5 text-left text-xs"
                      >
                        {l.text || "Empty text"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <SlidePhotoPicker
        open={picking !== null}
        onOpenChange={(open) => !open && setPicking(null)}
        load={loadPhotos}
        onSelect={(photo) => placePhoto(photo.url)}
      />
    </div>
  );
}
