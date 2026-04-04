import { useState, useEffect } from "react";
import { motion, AnimatePresence, Variants } from "framer-motion";
import { previewStyles, type CaptionStyle } from "./CaptionStyleSelector";

const PREVIEW_WORDS = ["You", "say", "you", "don't", "keep", "score"];
const WORD_DURATION_MS = 450;
const LOOP_PAUSE_MS = 1200;

interface CaptionPreviewAnimationProps {
  captionStyle: CaptionStyle;
}

// 20 distinct animation physics mapped to the styles
const styleAnimations: Record<CaptionStyle, Variants> = {
  none: { hidden: { opacity: 0 }, visible: { opacity: 0 } },

  // Reference Visuals
  orangeBox: {
    hidden: { opacity: 0, scale: 0.5, y: 15 },
    visible: { opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 400, damping: 15 } },
  },
  yellowSlanted: {
    hidden: { opacity: 0, scale: 2, rotate: -10 },
    visible: { opacity: 1, scale: 1, rotate: 0, transition: { type: "spring", stiffness: 350, damping: 18 } },
  },
  redSlantedBox: {
    hidden: { opacity: 0, x: -30, skewX: -20 },
    visible: { opacity: 1, x: 0, skewX: -10, transition: { duration: 0.25, ease: "easeOut" } },
  },
  cyanOutline: {
    hidden: { opacity: 0, scale: 0.7 },
    visible: { opacity: 1, scale: 1, transition: { type: "spring", bounce: 0.6 } },
  },
  motionBlur: {
    hidden: { opacity: 0, x: -80, filter: "blur(15px)" },
    visible: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: 0.25, ease: "circOut" } },
  },
  yellowSmall: {
    hidden: { opacity: 0, y: 8 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: "easeOut" } },
  },

  // Trending / Premium
  thickStroke: {
    hidden: { opacity: 0, scale: 1.5 },
    visible: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 500, damping: 25 } },
  },
  karaokePop: {
    hidden: { opacity: 0.5, scale: 0.9 },
    visible: { opacity: 1, scale: 1.2, color: "#FFEB3B", transition: { type: "spring", stiffness: 400 } },
  },
  neonTeal: {
    hidden: { opacity: 0, filter: "brightness(0.5) blur(4px)" },
    visible: { opacity: 1, filter: "brightness(1) blur(0px)", transition: { duration: 0.3 } },
  },
  goldLuxury: {
    hidden: { opacity: 0, y: 10, rotateX: 90 },
    visible: { opacity: 1, y: 0, rotateX: 0, transition: { duration: 0.4, ease: "backOut" } },
  },
  bouncyPill: {
    hidden: { opacity: 0, scale: 0, y: 20 },
    visible: { opacity: 1, scale: 1, y: 0, transition: { type: "spring", bounce: 0.7 } },
  },
  glitch: {
    hidden: { opacity: 0, x: 10, skewX: 20 },
    visible: { opacity: 1, x: 0, skewX: 0, transition: { duration: 0.1, type: "keyframes", ease: "circInOut" } },
  },
  comicBurst: {
    hidden: { opacity: 0, scale: 0.2, rotate: -25 },
    visible: { opacity: 1, scale: 1.1, rotate: 5, transition: { type: "spring", stiffness: 300, damping: 10 } },
  },
  redTag: {
    hidden: { opacity: 0, x: -10 },
    visible: { opacity: 1, x: 0, transition: { duration: 0.15 } },
  },
  blackBox: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.1 } },
  },
  typewriter: {
    hidden: { opacity: 0, display: "none" },
    visible: { opacity: 1, display: "inline-block", transition: { duration: 0.05 } },
  },
  cinematicFade: {
    hidden: { opacity: 0, filter: "blur(5px)", y: 5 },
    visible: { opacity: 1, filter: "blur(0px)", y: 0, transition: { duration: 0.6, ease: "easeOut" } },
  },
  retroTerminal: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.1, type: "tween" } },
  },
  heavyDropShadow: {
    hidden: { opacity: 0, y: -20 },
    visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 400, damping: 12 } },
  },
};

export function CaptionPreviewAnimation({ captionStyle }: CaptionPreviewAnimationProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const totalWords = PREVIEW_WORDS.length;
    const timer = setInterval(() => {
      setActiveIndex((prev) => {
        if (prev >= totalWords - 1) {
          setTimeout(() => setCycle((c) => c + 1), LOOP_PAUSE_MS);
          return 0;
        }
        return prev + 1;
      });
    }, WORD_DURATION_MS);

    return () => clearInterval(timer);
  }, [cycle]);

  const styleClass = previewStyles[captionStyle] || "";
  const animationVariants = styleAnimations[captionStyle] || styleAnimations.orangeBox;

  // Some styles look better accumulating words (typewriter, classic), others look better isolated
  const isAccumulativeStyle = ["blackBox", "cinematicFade", "typewriter", "retroTerminal"].includes(captionStyle);

  return (
    <div className="relative w-full h-36 bg-gradient-to-b from-gray-800 to-gray-950 rounded-lg overflow-hidden flex items-center justify-center border border-border/20 p-4">
      <div className={`flex flex-wrap justify-center gap-2 ${isAccumulativeStyle ? "w-full text-center" : "absolute"}`}>
        <AnimatePresence mode="popLayout">
          {PREVIEW_WORDS.map((word, idx) => {
            if (!isAccumulativeStyle && idx !== activeIndex) return null;
            if (isAccumulativeStyle && idx > activeIndex) return null;

            return (
              <motion.span
                key={`${word}-${idx}-${cycle}`}
                variants={animationVariants}
                initial="hidden"
                animate="visible"
                exit="hidden"
                className={`inline-block ${styleClass}`}
              >
                {word}
              </motion.span>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
