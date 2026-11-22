import clsx from 'clsx'
import styles from './Spinner.module.css'

export const Spinner = ({ className }: { className?: string }) => (
  <span className={clsx(styles.spinner, className)} aria-hidden="true" />
)
