/* Mission Board 高频运行时：结构签名与行内状态补丁。
   这里不依赖业务 store，便于对数字人/信息流的轮询压力做纯前端回归。 */

export function boardStructureKey(groups = []) {
  return groups.map(group => `${group.id}:${(group.productionIds || []).join(",")}`).join("|");
}

/* 将新状态打到现有行上；行、缩略图和 src 未变时均保留原 DOM。 */
export function patchBoardRow(row, fresh) {
  if (!row || !fresh) return false;
  row.className = fresh.className;

  const oldPreview = row.querySelector(".mb-preview");
  const newPreview = fresh.querySelector(".mb-preview");
  if (oldPreview && newPreview) {
    const oldImg = oldPreview.querySelector("img");
    const newImg = newPreview.querySelector("img");
    if (oldImg && newImg && oldImg.getAttribute("src") !== newImg.getAttribute("src")) {
      oldImg.setAttribute("src", newImg.getAttribute("src") || "");
      oldImg.setAttribute("alt", newImg.getAttribute("alt") || "");
    }
  } else if (!oldPreview && newPreview) {
    row.insertBefore(newPreview.cloneNode(true), row.firstChild);
  } else if (oldPreview && !newPreview) {
    oldPreview.remove();
  }

  const oldType = row.querySelector(".mb-type");
  const newType = fresh.querySelector(".mb-type");
  if (oldType && newType) { oldType.className = newType.className; oldType.textContent = newType.textContent; }
  const oldAccount = row.querySelector(".mb-top > b");
  const newAccount = fresh.querySelector(".mb-top > b");
  if (oldAccount && newAccount) oldAccount.textContent = newAccount.textContent;
  const oldStatus = row.querySelector(".status-pill");
  const newStatus = fresh.querySelector(".status-pill");
  if (oldStatus && newStatus) { oldStatus.className = newStatus.className; oldStatus.textContent = newStatus.textContent; }
  const oldTitle = row.querySelector(".mb-title");
  const newTitle = fresh.querySelector(".mb-title");
  if (oldTitle && newTitle) oldTitle.textContent = newTitle.textContent;

  const oldDots = row.querySelector(".mb-dots");
  const newDots = fresh.querySelector(".mb-dots");
  if (oldDots && newDots) {
    const oldNodes = [...oldDots.querySelectorAll(".mb-dot")];
    const newNodes = [...newDots.querySelectorAll(".mb-dot")];
    if (oldNodes.length === newNodes.length) {
      oldNodes.forEach((node, index) => {
        node.className = newNodes[index].className;
        node.title = newNodes[index].title;
      });
      const oldSub = oldDots.querySelector(".mb-sub");
      const newSub = newDots.querySelector(".mb-sub");
      if (oldSub && newSub) { oldSub.className = newSub.className; oldSub.textContent = newSub.textContent; }
      else if (!oldSub && newSub) oldDots.appendChild(newSub.cloneNode(true));
      else if (oldSub && !newSub) oldSub.remove();
    } else {
      oldDots.innerHTML = newDots.innerHTML;
    }
  }
  return true;
}
