/** The approval badge uses radial spokes; private-form receipts use a ring. */
export function PermissionSpinner() {
  return (
    <svg
      aria-hidden="true"
      className="permission-approval-spinner"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <path key={index} d="M8 1.5v3" transform={`rotate(${index * 45} 8 8)`} />
      ))}
    </svg>
  );
}
