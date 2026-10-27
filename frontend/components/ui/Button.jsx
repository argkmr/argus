import styles from "./Button.module.css";

export function Button({ variant = "secondary", compact = false, className = "", children, ...props }) {
  return <button className={`${styles.button} ${styles[variant]} ${compact ? styles.compact : ""} ${className}`.trim()} {...props}>{children}</button>;
}

export function CloseButton({ label = "Close", className = "", ...props }) {
  return <Button type="button" variant="secondary" compact className={`${styles.close} command-close ${className}`.trim()} aria-label={label} title={label} {...props}>×</Button>;
}
