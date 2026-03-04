import { forwardRef, HTMLAttributes } from "react";
import motionmaxLogo from "@/assets/motionmax-logo.png";

interface ThemedLogoProps extends HTMLAttributes<HTMLImageElement> {
  className?: string;
  alt?: string;
}

export const ThemedLogo = forwardRef<HTMLImageElement, ThemedLogoProps>(
  ({ className = "h-10 w-auto", alt = "MotionMax", ...props }, ref) => {
    return <img ref={ref} src={motionmaxLogo} alt={alt} className={className} {...props} />;
  }
);

ThemedLogo.displayName = "ThemedLogo";
