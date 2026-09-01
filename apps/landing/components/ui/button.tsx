import { cva, type VariantProps } from "class-variance-authority";
import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactElement } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva("button", {
  variants: {
    variant: {
      default: "button-primary",
      outline: "button-secondary",
      ghost: "button-ghost",
    },
    size: {
      default: "button-default",
      sm: "button-sm",
      lg: "button-lg",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export function Button({ asChild, className, variant, size, children, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>;
    return cloneElement(child, { className: cn(classes, child.props.className) });
  }
  return (
    <button className={classes} {...props}>
      {children}
    </button>
  );
}
