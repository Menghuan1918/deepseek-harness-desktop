declare module '*.module.css' {
  /** Hashed class map compiled by the DSH client bundle preset. */
  const classes: Record<string, string>
  export default classes
}
