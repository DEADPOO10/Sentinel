"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function SelectRepositoryButton({ repositoryName }: { repositoryName: string }) {
  const [isSelected, setIsSelected] = useState(false);

  return <Button type="button" variant={isSelected ? "outline" : "default"} size="sm" aria-pressed={isSelected} aria-label={`${isSelected ? "Deselect" : "Select"} ${repositoryName}`} onClick={() => setIsSelected((selected) => !selected)}>{isSelected ? "Selected" : "Select repository"}</Button>;
}
