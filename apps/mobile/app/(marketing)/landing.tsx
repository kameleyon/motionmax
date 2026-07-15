/**
 * MotionMax — mobile landing screen (Expo / React Native).
 *
 * Ported from the Claude Design file "MotionMax Landing.dc.html"
 * (project 7726b20a-359b-4557-9e54-54b0f3355f32). Dark, mobile-first:
 * sticky header + hamburger, hero with animated audio bars, 6 feature
 * cards, 3-tier pricing (monthly/annual toggle), 5-item FAQ accordion,
 * gradient CTA, footer.
 *
 * Dependencies (add during Phase 1 scaffold):
 *   npx expo install expo-linear-gradient \
 *     @expo-google-fonts/newsreader @expo-google-fonts/instrument-sans expo-font
 *
 * Load the fonts once at the app root (app/_layout.tsx):
 *   import { useFonts } from 'expo-font';
 *   import { Newsreader_400Regular, Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader';
 *   import { InstrumentSans_400Regular, InstrumentSans_500Medium, InstrumentSans_600SemiBold } from '@expo-google-fonts/instrument-sans';
 *   const [loaded] = useFonts({ Newsreader_400Regular, Newsreader_400Regular_Italic,
 *     InstrumentSans_400Regular, InstrumentSans_500Medium, InstrumentSans_600SemiBold });
 * The screen degrades to the system font if they aren't loaded yet.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
// Metro resolves the webp asset to a module id at bundle time.
import LOGO from '../../assets/motionmax-logo.webp';

// ── Design tokens ───────────────────────────────────────────────────
const C = {
  bg: '#0A0E15',
  card: '#121826',
  cardBorder: '#1F2A3B',
  text: '#ECF1F1',
  headline: '#F2F6F6',
  muted: '#8593A2',
  muted2: '#A9B6C3',
  muted3: '#6E7C8B',
  teal: '#14C4C9',
  teal2: '#35D6DB',
  tealLight: '#8FF0F0',
  onTeal: '#04211F',
};
const F = {
  serif: 'Newsreader_400Regular',
  serifItalic: 'Newsreader_400Regular_Italic',
  body: 'InstrumentSans_400Regular',
  medium: 'InstrumentSans_500Medium',
  semibold: 'InstrumentSans_600SemiBold',
};

// ── Data (verbatim from the design) ─────────────────────────────────
const TEAL_TINT = 'rgba(53,214,219,0.14)';
const GOLD_TINT = 'rgba(143,240,240,0.16)';

const FEATURES = [
  { icon: '📝', tint: TEAL_TINT, title: 'Text to video', body: 'Drop in a prompt or full script and get a shot-listed, narrated video in minutes.' },
  { icon: '📰', tint: GOLD_TINT, title: 'Article to video', body: 'Paste any URL — MotionMax summarizes and turns it into a shareable visual story.' },
  { icon: '🎬', tint: TEAL_TINT, title: 'Cinematic scenes', body: 'AI-directed camera moves, transitions, and grading for a premium, filmic look.' },
  { icon: '📊', tint: GOLD_TINT, title: 'Auto infographics', body: 'Turn data and bullet points into clean animated charts and infographic reels.' },
  { icon: '🎙️', tint: TEAL_TINT, title: 'Natural voiceover', body: 'Lifelike AI narration in 30+ languages, or clone your own voice in a click.' },
  { icon: '⚡', tint: GOLD_TINT, title: 'One-click export', body: 'Publish to vertical, square, or wide in the right size for every platform.' },
];

type Plan = {
  name: string; featured: boolean; price: { monthly: string; annual: string }; unit: string; tagline: string;
  perks: string[]; cardBg: string; border: string; nameColor: string; priceColor: string;
  mutedColor: string; textColor: string; checkColor: string; btnBg: string; btnColor: string; btnBorder: string; cta: string;
};
const PLANS: Plan[] = [
  {
    name: 'Free', featured: false, price: { monthly: '$0', annual: '$0' }, unit: '', tagline: 'For trying things out.',
    perks: ['3 video renders / mo', '720p exports', 'Core templates', 'MotionMax watermark'],
    cardBg: C.card, border: C.cardBorder, nameColor: C.text, priceColor: C.headline, mutedColor: C.muted,
    textColor: '#C3CDD6', checkColor: C.teal2, btnBg: '#1A2131', btnColor: C.teal2, btnBorder: '#2A3546', cta: 'Get started',
  },
  {
    name: 'Creator', featured: true, price: { monthly: '$19', annual: '$15' }, unit: '/ mo', tagline: 'For growing your channel.',
    perks: ['Unlimited renders', '1080p + 4K exports', 'No watermark', 'Voice cloning & brand kit', 'Priority rendering'],
    cardBg: '#07323C', border: '#3DE0E4', nameColor: '#FFFFFF', priceColor: '#FFFFFF', mutedColor: 'rgba(255,255,255,0.64)',
    textColor: 'rgba(255,255,255,0.9)', checkColor: C.tealLight, btnBg: C.tealLight, btnColor: '#1A1405', btnBorder: C.tealLight, cta: 'Start free trial',
  },
  {
    name: 'Studio', featured: false, price: { monthly: '$59', annual: '$47' }, unit: '/ mo', tagline: 'For teams & agencies.',
    perks: ['Everything in Creator', 'Team workspace & seats', 'Custom AI avatars', 'API access', 'Dedicated support'],
    cardBg: C.card, border: C.cardBorder, nameColor: C.text, priceColor: C.headline, mutedColor: C.muted,
    textColor: '#C3CDD6', checkColor: C.teal2, btnBg: '#1A2131', btnColor: C.teal2, btnBorder: '#2A3546', cta: 'Choose Studio',
  },
];

const FAQS = [
  { q: 'How does MotionMax turn text into video?', a: 'Paste an idea, script, or article link. MotionMax scripts, storyboards, generates visuals and voiceover, then renders a finished video — you just review and tweak.' },
  { q: 'What kinds of videos can I make?', a: 'Explainers, social clips, cinematic shorts, visual stories, and animated infographics. Pick a format and MotionMax handles pacing, captions, and music.' },
  { q: 'Can I use my own footage and brand?', a: 'Yes. Upload clips, images, logos, fonts, and colors — your brand kit is applied automatically across every render.' },
  { q: 'Do I own the videos I create?', a: 'Fully. Everything you generate is yours to use commercially, with royalty-free music and visuals included on paid plans.' },
  { q: 'Is there a free plan?', a: 'Yes — start free with 3 renders and no credit card. Upgrade any time as you grow.' },
];

const NAV_LINKS = ['Features', 'Pricing', 'FAQ'] as const;
const FOOTER_COLS = [
  { title: 'Product', links: ['Features', 'Pricing', 'Templates', 'Changelog'] },
  { title: 'Company', links: ['About', 'Blog', 'Careers', 'Contact'] },
];

// ── Animated audio bars (28) ────────────────────────────────────────
function AudioBars() {
  const anims = useRef(Array.from({ length: 28 }, () => new Animated.Value(0.35))).current;
  useEffect(() => {
    const loops = anims.map((v, i) => {
      const dur = 800 + ((i * 37) % 90) * 10;
      const delay = ((i * 53) % 100) * 10;
      return Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 1, duration: dur / 2, delay, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.35, duration: dur / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      );
    });
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [anims]);
  return (
    <View style={styles.bars}>
      {anims.map((v, i) => (
        <Animated.View key={i} style={{ transform: [{ scaleY: v }] }}>
          <LinearGradient colors={[C.teal2, C.tealLight]} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={styles.bar} />
        </Animated.View>
      ))}
    </View>
  );
}

function FaqItem({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  return (
    <View style={styles.faqItem}>
      <Pressable onPress={onToggle} style={styles.faqBtn}>
        <Text style={styles.faqQ}>{q}</Text>
        <Text style={[styles.faqIcon, open && { transform: [{ rotate: '45deg' }] }]}>+</Text>
      </Pressable>
      {open && <Text style={styles.faqA}>{a}</Text>}
    </View>
  );
}

export default function LandingScreen({ onGetStarted }: { onGetStarted?: () => void }) {
  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef<Record<string, number>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [annual, setAnnual] = useState(false);
  const [openFaq, setOpenFaq] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  const start = onGetStarted ?? (() => Linking.openURL('https://www.motionmax.io'));
  const onSectionLayout = (key: string) => (e: LayoutChangeEvent) => { offsets.current[key] = e.nativeEvent.layout.y; };
  const scrollTo = (key: string) => {
    setMenuOpen(false);
    const y = offsets.current[key.toLowerCase()];
    if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - 68), animated: true });
  };

  const headerBg = scrolled ? 'rgba(10,14,21,0.92)' : 'rgba(10,14,21,0.6)';
  const pill = (active: boolean) =>
    active
      ? { backgroundColor: '#2A3446', color: C.text }
      : { backgroundColor: 'transparent', color: C.muted };

  return (
    <View style={styles.root}>
      {/* HEADER */}
      <View style={[styles.header, { backgroundColor: headerBg, borderBottomColor: scrolled ? 'rgba(255,255,255,0.06)' : 'transparent' }]}>
        <View style={styles.brandRow}>
          <Image source={LOGO} style={styles.logo} resizeMode="contain" />
          <Text style={styles.brand}>MotionMax</Text>
        </View>
        <Pressable onPress={() => setMenuOpen((o) => !o)} accessibilityLabel="Menu" style={styles.burger} hitSlop={8}>
          <View style={[styles.burgerBar, menuOpen && { transform: [{ translateY: 6.5 }, { rotate: '45deg' }] }]} />
          <View style={[styles.burgerBar, { opacity: menuOpen ? 0 : 1 }]} />
          <View style={[styles.burgerBar, menuOpen && { transform: [{ translateY: -6.5 }, { rotate: '-45deg' }] }]} />
        </Pressable>
      </View>

      {/* MOBILE MENU */}
      {menuOpen && (
        <View style={styles.menu}>
          {NAV_LINKS.map((label) => (
            <Pressable key={label} onPress={() => scrollTo(label)} style={styles.menuLink}>
              <Text style={styles.menuLinkText}>{label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={start} style={styles.menuCta}>
            <Text style={styles.menuCtaText}>Start free trial</Text>
          </Pressable>
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e) => {
          const s = e.nativeEvent.contentOffset.y > 16;
          if (s !== scrolled) setScrolled(s);
        }}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {/* HERO */}
        <View style={styles.hero}>
          <View style={[styles.orb, { top: -30, left: -60, backgroundColor: 'rgba(53,214,219,0.20)' }]} />
          <View style={[styles.orb, { top: 40, right: -70, backgroundColor: 'rgba(143,240,240,0.16)' }]} />
          <View style={styles.badge}>
            <LinearGradient colors={[C.teal2, C.tealLight]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.badgeDot} />
            <Text style={styles.badgeText}>Full-stack AI video studio</Text>
          </View>
          <Text style={styles.h1}>
            Turn any idea into <Text style={styles.h1Em}>cinematic</Text> video.
          </Text>
          <Text style={styles.heroSub}>
            MotionMax transforms text, articles, and ideas into polished videos, explainers, visual stories, and infographics — all powered by AI.
          </Text>
          <View style={{ gap: 10, marginTop: 26 }}>
            <Pressable onPress={start} style={({ pressed }) => [styles.ctaPrimary, pressed && styles.pressed]}>
              <Text style={styles.ctaPrimaryText}>Start free trial →</Text>
            </Pressable>
            <Pressable onPress={() => scrollTo('features')} style={({ pressed }) => [styles.ctaSecondary, pressed && styles.pressed]}>
              <Text style={styles.ctaSecondaryText}>See how it works</Text>
            </Pressable>
          </View>
          <Text style={styles.finePrint}>No credit card · 3 free renders</Text>
          <AudioBars />
        </View>

        {/* FEATURES */}
        <View style={styles.section} onLayout={onSectionLayout('features')}>
          <Text style={styles.eyebrow}>Capabilities</Text>
          <Text style={styles.h2}>Everything you need to create, in one place.</Text>
          <View style={{ gap: 12, marginTop: 26 }}>
            {FEATURES.map((f) => (
              <View key={f.title} style={styles.featureCard}>
                <View style={[styles.featureIcon, { backgroundColor: f.tint }]}>
                  <Text style={{ fontSize: 20 }}>{f.icon}</Text>
                </View>
                <Text style={styles.featureTitle}>{f.title}</Text>
                <Text style={styles.featureBody}>{f.body}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* PRICING */}
        <View style={styles.section} onLayout={onSectionLayout('pricing')}>
          <Text style={[styles.eyebrow, styles.center]}>Pricing</Text>
          <Text style={[styles.h2, styles.center]}>Simple, creator-friendly plans.</Text>
          <View style={styles.toggle}>
            <Pressable onPress={() => setAnnual(false)} style={[styles.togglePill, { backgroundColor: pill(!annual).backgroundColor }]}>
              <Text style={[styles.togglePillText, { color: pill(!annual).color }]}>Monthly</Text>
            </Pressable>
            <Pressable onPress={() => setAnnual(true)} style={[styles.togglePill, { backgroundColor: pill(annual).backgroundColor }]}>
              <Text style={[styles.togglePillText, { color: pill(annual).color }]}>
                Annual <Text style={{ color: C.tealLight }}>−20%</Text>
              </Text>
            </Pressable>
          </View>
          <View style={{ gap: 14, marginTop: 24 }}>
            {PLANS.map((p) => (
              <View key={p.name} style={[styles.planCard, { backgroundColor: p.cardBg, borderColor: p.border }]}>
                {p.featured && (
                  <View style={styles.planBadge}>
                    <Text style={styles.planBadgeText}>MOST POPULAR</Text>
                  </View>
                )}
                <Text style={[styles.planName, { color: p.nameColor }]}>{p.name}</Text>
                <View style={styles.planPriceRow}>
                  <Text style={[styles.planPrice, { color: p.priceColor }]}>{annual ? p.price.annual : p.price.monthly}</Text>
                  <Text style={[styles.planUnit, { color: p.mutedColor }]}>{p.unit}</Text>
                </View>
                <Text style={[styles.planTagline, { color: p.mutedColor }]}>{p.tagline}</Text>
                <View style={{ gap: 11, marginTop: 20 }}>
                  {p.perks.map((perk) => (
                    <View key={perk} style={styles.perkRow}>
                      <Text style={[styles.perkCheck, { color: p.checkColor }]}>✓</Text>
                      <Text style={[styles.perkText, { color: p.textColor }]}>{perk}</Text>
                    </View>
                  ))}
                </View>
                <Pressable onPress={start} style={({ pressed }) => [styles.planCta, { backgroundColor: p.btnBg, borderColor: p.btnBorder }, pressed && styles.pressed]}>
                  <Text style={[styles.planCtaText, { color: p.btnColor }]}>{p.cta}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>

        {/* FAQ */}
        <View style={styles.section} onLayout={onSectionLayout('faq')}>
          <Text style={[styles.eyebrow, styles.center]}>FAQ</Text>
          <Text style={[styles.h2, styles.center, { marginBottom: 24 }]}>Questions, answered.</Text>
          <View style={{ gap: 10 }}>
            {FAQS.map((f, i) => (
              <FaqItem key={f.q} q={f.q} a={f.a} open={openFaq === i} onToggle={() => setOpenFaq((o) => (o === i ? -1 : i))} />
            ))}
          </View>
        </View>

        {/* CTA */}
        <View style={styles.section} onLayout={onSectionLayout('start')}>
          <LinearGradient
            colors={['#0B8F92', '#14C4C9', '#8FF0F0']}
            locations={[0, 0.52, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.ctaBanner}
          >
            <Text style={styles.ctaBannerH}>Your first video is 60 seconds away.</Text>
            <Text style={styles.ctaBannerSub}>Start free — no credit card required. Cancel anytime.</Text>
            <Pressable onPress={start} style={({ pressed }) => [styles.ctaBannerBtn, pressed && styles.pressed]}>
              <Text style={styles.ctaBannerBtnText}>Start free trial →</Text>
            </Pressable>
          </LinearGradient>
        </View>

        {/* FOOTER */}
        <View style={styles.footer}>
          <View style={styles.brandRow}>
            <Image source={LOGO} style={styles.logoSm} resizeMode="contain" />
            <Text style={styles.brandSm}>MotionMax</Text>
          </View>
          <Text style={styles.footerTagline}>The full-stack AI video studio for creators.</Text>
          <View style={styles.footerCols}>
            {FOOTER_COLS.map((col) => (
              <View key={col.title} style={{ flex: 1 }}>
                <Text style={styles.footerColTitle}>{col.title}</Text>
                <View style={{ gap: 10 }}>
                  {col.links.map((l) => (
                    <Text key={l} style={styles.footerLink}>{l}</Text>
                  ))}
                </View>
              </View>
            ))}
          </View>
          <View style={styles.footerBottom}>
            <Text style={styles.copyright}>© 2026 MotionMax</Text>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Text style={styles.copyright}>Privacy</Text>
              <Text style={styles.copyright}>Terms</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  pressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },
  center: { textAlign: 'center' },

  header: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14, paddingTop: 48, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  logo: { width: 34, height: 34 },
  logoSm: { width: 30, height: 30 },
  brand: { fontFamily: F.semibold, fontSize: 18, letterSpacing: -0.4, color: C.text },
  brandSm: { fontFamily: F.semibold, fontSize: 17, letterSpacing: -0.4, color: C.text },
  burger: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 10 },
  burgerBar: { width: 20, height: 1.5, backgroundColor: C.text, borderRadius: 2 },

  menu: {
    position: 'absolute', top: 92, left: 12, right: 12, zIndex: 49, padding: 8,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.cardBorder, borderRadius: 18,
    shadowColor: '#000', shadowOpacity: 0.7, shadowRadius: 24, shadowOffset: { width: 0, height: 18 }, elevation: 12,
  },
  menuLink: { paddingVertical: 13, paddingHorizontal: 14, borderRadius: 12 },
  menuLinkText: { fontFamily: F.medium, fontSize: 16, color: C.text },
  menuCta: { marginTop: 4, paddingVertical: 13, borderRadius: 12, backgroundColor: C.teal, alignItems: 'center' },
  menuCtaText: { fontFamily: F.semibold, fontSize: 16, color: '#06201F' },

  hero: { paddingHorizontal: 22, paddingTop: 118, paddingBottom: 40, position: 'relative', overflow: 'hidden' },
  orb: { position: 'absolute', width: 260, height: 260, borderRadius: 130, opacity: 0.9 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    paddingVertical: 6, paddingLeft: 8, paddingRight: 12, backgroundColor: C.card,
    borderWidth: 1, borderColor: C.cardBorder, borderRadius: 999,
  },
  badgeDot: { width: 18, height: 18, borderRadius: 9 },
  badgeText: { fontFamily: F.body, fontSize: 12.5, color: C.muted2 },
  h1: { fontFamily: F.serif, fontSize: 42, lineHeight: 44, letterSpacing: -0.8, color: C.headline, marginTop: 20 },
  h1Em: { fontFamily: F.serifItalic, fontStyle: 'italic', color: C.teal2 },
  heroSub: { fontFamily: F.body, fontSize: 16.5, lineHeight: 26, color: C.muted, marginTop: 16, maxWidth: 320 },

  ctaPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 16,
    backgroundColor: C.teal, borderRadius: 14,
    shadowColor: '#0FA7A3', shadowOpacity: 0.6, shadowRadius: 24, shadowOffset: { width: 0, height: 14 }, elevation: 8,
  },
  ctaPrimaryText: { fontFamily: F.semibold, fontSize: 16, color: C.onTeal },
  ctaSecondary: {
    alignItems: 'center', justifyContent: 'center', padding: 15,
    backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(36,48,66,0.6)', borderRadius: 14,
  },
  ctaSecondaryText: { fontFamily: F.semibold, fontSize: 16, color: C.text },
  finePrint: { fontFamily: F.body, fontSize: 12.5, color: C.muted3, marginTop: 14, textAlign: 'center' },

  bars: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, height: 40, marginTop: 34, opacity: 0.85 },
  bar: { width: 4, height: 40, borderRadius: 3 },

  section: { paddingHorizontal: 22, paddingTop: 44, paddingBottom: 12 },
  eyebrow: { fontFamily: F.semibold, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase', color: C.teal2 },
  h2: { fontFamily: F.serif, fontSize: 31, lineHeight: 35, letterSpacing: -0.6, color: C.headline, marginTop: 10 },

  featureCard: { padding: 20, backgroundColor: C.card, borderWidth: 1, borderColor: C.cardBorder, borderRadius: 18 },
  featureIcon: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  featureTitle: { fontFamily: F.semibold, fontSize: 17, letterSpacing: -0.2, color: C.text, marginTop: 16 },
  featureBody: { fontFamily: F.body, fontSize: 14.5, lineHeight: 22, color: C.muted, marginTop: 7 },

  toggle: {
    flexDirection: 'row', alignSelf: 'center', marginTop: 20, padding: 4,
    backgroundColor: '#121A28', borderWidth: 1, borderColor: C.cardBorder, borderRadius: 999,
  },
  togglePill: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 999 },
  togglePillText: { fontFamily: F.semibold, fontSize: 13.5 },

  planCard: { position: 'relative', padding: 24, borderWidth: 1, borderRadius: 20 },
  planBadge: { position: 'absolute', top: -11, left: 24, paddingVertical: 4, paddingHorizontal: 12, backgroundColor: C.tealLight, borderRadius: 999 },
  planBadgeText: { fontFamily: F.semibold, fontSize: 11, letterSpacing: 0.4, color: '#1A1405' },
  planName: { fontFamily: F.semibold, fontSize: 17 },
  planPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 12 },
  planPrice: { fontFamily: F.serif, fontSize: 40, letterSpacing: -0.8 },
  planUnit: { fontFamily: F.body, fontSize: 14 },
  planTagline: { fontFamily: F.body, fontSize: 14, marginTop: 4 },
  perkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  perkCheck: { fontFamily: F.semibold, fontSize: 14.5, lineHeight: 20 },
  perkText: { fontFamily: F.body, fontSize: 14.5, lineHeight: 20, flex: 1 },
  planCta: { marginTop: 22, paddingVertical: 14, borderRadius: 13, borderWidth: 1, alignItems: 'center' },
  planCtaText: { fontFamily: F.semibold, fontSize: 15 },

  faqItem: { backgroundColor: C.card, borderWidth: 1, borderColor: C.cardBorder, borderRadius: 16, overflow: 'hidden' },
  faqBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 18, paddingVertical: 17 },
  faqQ: { fontFamily: F.semibold, fontSize: 15.5, color: C.text, lineHeight: 21, flex: 1 },
  faqIcon: { fontFamily: F.body, fontSize: 22, color: C.teal2 },
  faqA: { fontFamily: F.body, fontSize: 14.5, lineHeight: 22, color: C.muted, paddingHorizontal: 18, paddingBottom: 18 },

  ctaBanner: { padding: 30, borderRadius: 26, overflow: 'hidden' },
  ctaBannerH: { fontFamily: F.serif, fontSize: 30, lineHeight: 34, letterSpacing: -0.6, color: '#FFFFFF' },
  ctaBannerSub: { fontFamily: F.body, fontSize: 15.5, lineHeight: 23, color: 'rgba(255,255,255,0.88)', marginTop: 12 },
  ctaBannerBtn: { marginTop: 22, padding: 16, backgroundColor: C.onTeal, borderRadius: 14, alignItems: 'center' },
  ctaBannerBtnText: { fontFamily: F.semibold, fontSize: 16, color: '#FFFFFF' },

  footer: { paddingHorizontal: 22, paddingTop: 40, paddingBottom: 34, marginTop: 20 },
  footerTagline: { fontFamily: F.body, fontSize: 14, lineHeight: 21, color: C.muted, marginTop: 12, maxWidth: 300 },
  footerCols: { flexDirection: 'row', gap: 20, marginTop: 28 },
  footerColTitle: { fontFamily: F.semibold, fontSize: 12, letterSpacing: 0.7, textTransform: 'uppercase', color: C.muted3, marginBottom: 12 },
  footerLink: { fontFamily: F.body, fontSize: 14.5, color: C.muted2 },
  footerBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 32, paddingTop: 20, borderTopWidth: 1, borderTopColor: C.cardBorder },
  copyright: { fontFamily: F.body, fontSize: 12.5, color: C.muted3 },
});
