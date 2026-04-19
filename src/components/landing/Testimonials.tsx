import { motion } from "framer-motion";

const useCases = [
  {
    quote: "Paste a script and get a polished explainer video in minutes — no editing timeline, no stock footage hunting, no render queue.",
    role: "Content Creators",
    icon: "✦",
  },
  {
    quote: "Cinematic mode produces TikTok and YouTube Shorts that look like they were made by a production team — without the production budget.",
    role: "Social Media Managers",
    icon: "✦",
  },
  {
    quote: "Internal training videos that used to take a week now take an afternoon. Multi-language support makes global rollouts straightforward.",
    role: "Learning & Development Teams",
    icon: "✦",
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
            Built for your workflow
          </span>
          <h2 className="type-h1 tracking-tight text-foreground">
            What you can do with MotionMax
          </h2>
        </motion.div>

        <div className="grid gap-6 md:grid-cols-3">
          {useCases.map((item, index) => (
            <motion.div
              key={item.role}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1, duration: 0.5 }}
              className="rounded-xl border border-border/50 bg-card/50 p-6 flex flex-col"
            >
              {/* Icon */}
              <div className="mb-4 text-primary text-lg">{item.icon}</div>

              {/* Description */}
              <p className="text-sm leading-relaxed text-foreground/80 flex-1">
                {item.quote}
              </p>

              {/* Role label */}
              <div className="mt-5 pt-4 border-t border-border/30">
                <p className="text-xs font-medium text-primary uppercase tracking-wide">{item.role}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
