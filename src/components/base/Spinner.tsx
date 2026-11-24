import clsx from 'clsx'
import { useId } from 'react'
import styles from './Spinner.module.css'

const ARC =
  'M34,18 C34,9.163444 26.836556,2 18,2 C11.6597233,2 6.18078805,5.68784135 3.59122325,11.0354951'

export const Spinner = ({ className, size = 32 }: { className?: string; size?: number }) => {
  const gradientId = 'spinner-' + useId().replace(/:/g, '')
  return (
    <span
      className={clsx(styles.spinner, className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient x1="0%" y1="100%" x2="100%" y2="100%" id={gradientId}>
            <stop stopColor="currentColor" stopOpacity="0" offset="0%" />
            <stop stopColor="currentColor" stopOpacity="0.5" offset="39.9430698%" />
            <stop stopColor="currentColor" offset="100%" />
          </linearGradient>
        </defs>
        <g stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
          <rect fillOpacity="0.01" fill="none" x="0" y="0" width="36" height="36" />
          <path d={ARC} stroke={`url(#${gradientId})`} strokeWidth="4" strokeLinecap="round" />
        </g>
      </svg>
    </span>
  )
}
