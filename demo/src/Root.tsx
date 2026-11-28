import React from "react";
import { Audio, Composition, getStaticFiles, staticFile, Sequence, type CalculateMetadataFunction } from "remotion";
import { getVideoMetadata } from "@remotion/media-utils";
import { fade } from "@remotion/transitions/fade";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { buildTimeline, INTRO_SECONDS, totalFrames } from "./timeline";
import { bladeWipe } from "./ui";
import { FPS } from "./theme";
import { RangeOption } from "./scenes/RangeOption";
import { Compiler } from "./scenes/Compiler";
import { X402 } from "./scenes/X402";
import { Pricing } from "./scenes/Pricing";
import { Proof } from "./scenes/Proof";
import { LogoReveal, Outro, PartTitle } from "./scenes/Titles";

const files = () => new Set(getStaticFiles().map((f) => f.name));

/** Starting frame of every item, after transition overlaps. */
function starts(items: ReturnType<typeof buildTimeline>) {
  const out: number[] = [];
  let t = 0;
  items.forEach((it, i) => {
    if (i > 0 && it.enter !== "cut") t -= it.enterFrames ?? 0;
    out.push(t);
    t += it.dur;
  });
  return out;
}

type DemoProps = { introSeconds: number };

export const Demo: React.FC<DemoProps> = ({ introSeconds }) => {
  const have = files();
  const items = buildTimeline(have, introSeconds);
  const at = starts(items);
  return (
    <>
      <TransitionSeries>
        {items.flatMap((it, i) => {
          const nodes: React.ReactNode[] = [];
          if (i > 0 && it.enter !== "cut") {
            nodes.push(
              <TransitionSeries.Transition
                key={`tr-${it.id}`}
                presentation={it.enter === "blade" ? bladeWipe() : fade()}
                timing={linearTiming({ durationInFrames: it.enterFrames ?? 8 })}
              />,
            );
          }
          nodes.push(
            <TransitionSeries.Sequence key={it.id} durationInFrames={it.dur}>
              {it.el}
            </TransitionSeries.Sequence>,
          );
          return nodes;
        })}
      </TransitionSeries>
      {/* your voice-over, one file per part, starting at that part's title card */}
      {items.map((it, i) =>
        it.part && have.has(`vo-${it.part}.wav`) ? (
          <Sequence key={`vo-${it.part}`} from={at[i]!}>
            <Audio src={staticFile(`vo-${it.part}.wav`)} />
          </Sequence>
        ) : null,
      )}
      {have.has("music.mp3") && <Audio src={staticFile("music.mp3")} volume={0.16} loop />}
    </>
  );
};

/** The video's length follows your recorded intro, when there is one. */
const fitIntro: CalculateMetadataFunction<DemoProps> = async ({ props }) => {
  const have = files();
  const introSeconds = have.has("intro.mp4") ? (await getVideoMetadata(staticFile("intro.mp4"))).durationInSeconds : props.introSeconds;
  return { durationInFrames: totalFrames(buildTimeline(have, introSeconds)), props: { introSeconds } };
};

const scene = (id: string, component: React.FC, seconds: number) => (
  <Composition key={id} id={id} component={component} durationInFrames={Math.round(seconds * FPS)} fps={FPS} width={1920} height={1080} />
);

export const Root: React.FC = () => (
  <>
    <Composition id="Demo" component={Demo} defaultProps={{ introSeconds: INTRO_SECONDS }} calculateMetadata={fitIntro} durationInFrames={totalFrames(buildTimeline(files()))} fps={FPS} width={1920} height={1080} />
    {/* single scenes, for previewing in the Studio */}
    {scene("LogoReveal", LogoReveal, 4.2)}
    {scene("PartTitle", () => <PartTitle n="01" kicker="For traders" title="Protect any token." sub="A floor under what you hold, built from Orca liquidity." />, 2.8)}
    {scene("RangeOption", RangeOption, 22)}
    {scene("Compiler", Compiler, 13)}
    {scene("X402", () => <X402 facts={{ path: "/x402/hedge", price: "0.01", tx: "2jGFVecbxi5x" }} />, 12)}
    {scene("Pricing", Pricing, 14)}
    {scene("Proof", Proof, 12)}
    {scene("Outro", Outro, 8)}
  </>
);
