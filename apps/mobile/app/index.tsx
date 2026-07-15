import { useRouter } from 'expo-router';
import LandingScreen from '../features/marketing/LandingScreen';

export default function Index() {
  const router = useRouter();
  // Every "Start free trial" / plan CTA on the landing routes to login.
  return <LandingScreen onGetStarted={() => router.push('/(auth)/login')} />;
}
