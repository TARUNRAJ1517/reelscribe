// Identity comes from the server session — this page no longer accepts
// an arbitrary email to look up, which used to let anyone view anyone
// else's transcript history just by typing in their address.
async function loadHistory() {
  const list = document.getElementById("historyList");
  const loginWall = document.getElementById("loginWall");

  let loggedIn = false;
  try {
    const me = await fetch("/me").then(r => r.json());
    loggedIn = !!me.loggedIn;
  } catch (e) {}

  if (!loggedIn) {
    loginWall.style.display = "block";
    return;
  }

  list.innerHTML = '<div class="state-msg">Loading your history…</div>';

  try {
    const res = await fetch("/history");
    const data = await res.json();

    if (!data.success) {
      list.innerHTML = '<div class="state-msg">Could not load your history. Please try again.</div>';
      return;
    }

    if (!data.data || data.data.length === 0) {
      list.innerHTML = '<div class="state-msg">No transcripts yet — create your first one from the dashboard.</div>';
      return;
    }

    list.innerHTML = "";
    data.data.forEach(item => {
      const date = new Date(item.createdAt).toLocaleDateString("en-IN", {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
      });
      const source = item.reelUrl?.includes("youtube") ? "YouTube" :
                     item.reelUrl?.includes("instagram") ? "Instagram" : "File Upload";

      const div = document.createElement("div");
      div.className = "history-item";
      div.innerHTML = `
        <div class="history-item-top">
          <div class="history-item-date">${date}</div>
          <div class="history-item-source">${source}</div>
        </div>
        <div class="history-item-url">${item.reelUrl || ""}</div>
        <div class="history-item-transcript"></div>
        <div class="history-item-toggle">Show more</div>
      `;
      div.querySelector(".history-item-transcript").textContent = item.transcript || "";
      const toggle = div.querySelector(".history-item-toggle");
      toggle.onclick = () => {
        div.classList.toggle("expanded");
        toggle.innerText = div.classList.contains("expanded") ? "Show less" : "Show more";
      };
      list.appendChild(div);
    });
  } catch (e) {
    list.innerHTML = '<div class="state-msg">Could not load your history. Please try again.</div>';
  }
}

loadHistory();
