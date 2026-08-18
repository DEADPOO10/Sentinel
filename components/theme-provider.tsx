const themeInitializationScript = `
  try {
    var savedTheme = localStorage.getItem("sentinel-theme");
    document.documentElement.classList.toggle("dark", savedTheme === "dark");
  } catch (_) {}
`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: themeInitializationScript }} />;
}
