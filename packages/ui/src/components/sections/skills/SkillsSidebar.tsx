import React from 'react';
import { NativeResourceSidebar } from '@/components/sections/resources/NativeResourceSidebar';

export const SkillsSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => (
  <NativeResourceSidebar kind="skill" onItemSelect={onItemSelect} />
);
