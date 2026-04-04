import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { previewStyles, type CaptionStyle } from "./CaptionStyleSelector";

const PREVIEW_WORDS = ["This", "is", "how", "your", "captions", "will", "look"];
const WORD_DURATION_MS = 400;
const LOOP_PAUSE_MS = 1200;

interface CaptionPreviewAnimationProps {
  captionStyle: CaptionStyle;
}

export function CaptionPreviewAnimation({ captionStyle }: CaptionPreviewAnimationProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const totalWords = PREVIEW_WORDS.length;
    const timer = setInterval(() => {
      setActiveIndex((prev) => {
        if (prev >= totalWords - 1) {
          // Reset cycle after pause
          setTimeout(() => setCycle((c) => c + 1), LOOP_PAUSE_MS);
          return 0;
        }
        return prev + 1;
      });
    }, WORD_DURATION_MS);

    return () => clearInterval(timer);
  }, [cycle]);

  const styleClass = previewStyles[captionStyle] || "";

  return (
    <div className="relative w-56 h-20 bg-gradient-to-b from-gray-700/80 to-gray-900/90 rounded-lg overflow-hidden flex items-end justify-center border border-border/20">
      <div className="absolute bottom-2.5 left-0 right-0 text-center px-3">
        <span className={styleClass}>
          <AnimatePresence mode="popLayout">
            {PREVIEW_WORDS.map((word, idx) => (
              <motion.span
                key={`${word}-${idx}-${cycle}`}
                initial={{ opacity: 0.3 }}
                animate={{ opacity: idx <= activeIndex ? 1 : 0.3 }}
                transition={{ duration: 0.15 }}
                className={idx <= activeIndex ? "" : "opacity-30"}
                style={{ marginRight: "0.25em" }}
              >
                {word}
              </motion.span>
            ))}
          </AnimatePresence>
        </span>
      </div>
    </div>
  );
}
