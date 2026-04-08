import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export function useKeyboard() {
  const navigate = useNavigate();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      switch (e.key) {
        case "1":
          navigate("/");
          break;
        case "2":
          navigate("/tasks");
          break;
        case "3":
          navigate("/schedules");
          break;
        case "4":
          navigate("/workflows");
          break;
        case "5":
          navigate("/dlq");
          break;
        case "/":
          e.preventDefault();
          document.getElementById("global-search")?.focus();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate]);
}
