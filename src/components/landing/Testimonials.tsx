import { motion } from "framer-motion";
import { Star } from "lucide-react";

const testimonials = [
  {
    quote: "I used to spend 8 hours editing a single explainer video. With MotionMax, I paste the script and get a polished video in 10 minutes. It's changed my entire workflow.",
    name: "Sarah K.",
    role: "Content Creator",
    avatar: null, // Replace with real photo URL
  },
  {
    quote: "The cinematic mode is incredible. I create TikTok and YouTube Shorts that look like they were made by a production team. My audience thinks I hired someone.",
    name: "Marcus J.",
    role: "Social Media Manager",
    avatar: null,
  },
  {
    quote: "We use MotionMax for our internal training videos. What took our L&D team a week now takes an afternoon. The multi-language support is a game changer for our global team.",
    name: "Priya M.",
    role: "Head of Learning & Development",
    avatar: null,
  },
];

export function Testimonials() {
  return (
    <section className="py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-6 sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <span className="inline-block mb-3 text-xs font-medium uppercase tracking-widest text-primary">
            What Creators Say
          </span>
          <h2 className="type-h1 tracking-tight text-foreground">
            Real results from real creators
          </h2>
        </motion.div>

        <div className="grid gap-6 md:grid-cols-3">
          {testimonials.map((t, index) => (
            <motion.div
              key={t.name}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1, duration: 0.5 }}
              className="rounded-xl border border-border/50 bg-card/50 p-6 flex flex-col"
            >
              {/* Stars */}
              <div className="flex gap-0.5 mb-4">
                {[1,2,3,4,5].map(i => (
                  <Star key={i} className="h-4 w-4 fill-[hsl(var(--gold))] text-[hsl(var(--gold))]" />
                ))}
              </div>

              {/* Quote */}
              <p className="text-sm leading-relaxed text-foreground/80 flex-1">
                "{t.quote}"
              </p>

              {/* Author */}
              <div className="flex items-center gap-3 mt-5 pt-4 border-t border-border/30">
                <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary/40 to-primary/20 flex items-center justify-center text-sm font-medium text-primary">
                  {t.name.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{t.name}</p>
                  <p className="text-xs text-muted-foreground">{t.role}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
