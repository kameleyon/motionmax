import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { previewStyles, type CaptionStyle } from "./CaptionStyleSelector";

const PREVIEW_WORDS = ["The", "night", "I", "saved", "your", "father's", "life,", "and", "therefore", "yours."];
const WORD_DURATION_MS = 300;
const PAUSE_DURATION_MS = 1500;

interface CaptionPreviewAnimationProps {
  captionStyle: CaptionStyle;
}

const capcutPhysics = { type: "spring" as const, stiffness: 1000, damping: 25, mass: 0.5 };

export function CaptionPreviewAnimation({ captionStyle }: CaptionPreviewAnimationProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const delay = activeIndex >= PREVIEW_WORDS.length ? PAUSE_DURATION_MS : WORD_DURATION_MS;
    const timer = setTimeout(() => {
      setActiveIndex((prev) => (prev >= PREVIEW_WORDS.length ? 0 : prev + 1));
    }, delay);
    return () => clearTimeout(timer);
  }, [activeIndex]);

  const styleClass = previewStyles[captionStyle] || "";

  return (
    <div className="relative w-full h-48 bg-gray-950 rounded-lg overflow-hidden flex items-center justify-center border border-border/20 shadow-inner p-6">
      {/* Background vignette */}
      <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white/10 to-transparent pointer-events-none" />

      {/* Multi-line word accumulation container */}
      <div className="flex flex-wrap items-center justify-center content-center gap-x-2 gap-y-1 text-center w-full max-w-[85%] z-10">
        <AnimatePresence mode="popLayout">
          {captionStyle !== "none" &&
            PREVIEW_WORDS.slice(0, activeIndex + 1).map((word, idx) => {
              const isActive = idx === activeIndex;

              return (
                <motion.span
                  key={`${word}-${idx}`}
                  initial={{ opacity: 0, scale: 0.6, y: 10 }}
                  animate={{
                    opacity: isActive ? 1 : 0.85,
                    scale: isActive ? 1.05 : 1,
                    y: 0,
                  }}
                  transition={capcutPhysics}
                  className={`inline-block text-lg ${styleClass}`}
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
