import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

export function SearchBar() {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = query.trim();
      if (trimmed) {
        navigate(`/jobs/${trimmed}`);
        setQuery("");
      }
    },
    [query, navigate],
  );

  return (
    <form onSubmit={handleSubmit} className="relative">
      <input
        id="global-search"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Job ID... (press /)"
        className="w-64 text-xs bg-board-bg border border-board-border rounded-md px-3 py-1.5 text-board-text placeholder:text-board-muted focus:outline-none focus:border-board-primary"
      />
    </form>
  );
}
