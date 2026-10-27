"use client";
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
const DiagramStudio = dynamic(() => import('./DiagramStudio'), { ssr: false, loading: () => <div className="diagram-loading" role="status">Opening your local diagram workspace…</div> });

export function DiagramStudioHost() {
  const [target,setTarget]=useState(null),[opened,setOpened]=useState(false),[visible,setVisible]=useState(false);
  useEffect(()=>{
    const root=document.getElementById('diagram-studio-panel');setTarget(root);
    const sync=()=>{const active=document.body.dataset.view==='diagrams';setVisible(active);if(active)setOpened(true);};
    sync();const observer=new MutationObserver(sync);observer.observe(document.body,{attributes:true,attributeFilter:['data-view']});
    return ()=>observer.disconnect();
  },[]);
  return target && opened ? createPortal(<DiagramStudio visible={visible}/>,target) : null;
}
