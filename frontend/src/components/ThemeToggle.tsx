import { useTheme } from "@/hooks/useTheme";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolved, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
      className="size-8"
      title={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`}
    >
      {resolved === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}