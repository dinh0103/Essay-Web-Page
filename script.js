// Progress bar + active TOC
window.onscroll = function() {

  let winScroll = document.body.scrollTop || document.documentElement.scrollTop;
  let height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  let scrolled = (winScroll / height) * 100;
  document.getElementById("progress-bar").style.width = scrolled + "%";

  let sections = document.querySelectorAll("section");
  let navLinks = document.querySelectorAll("nav a");
  let current = "";

  sections.forEach(function(section) {
    let sectionTop = section.offsetTop - 120;
    if (window.scrollY >= sectionTop) {
      current = section.getAttribute("id");
    }
  });

  navLinks.forEach(function(link) {
    link.classList.remove("active");
    if (link.getAttribute("href") === "#" + current) {
      link.classList.add("active");
    }
  });

};

// Dark mode
const toggle = document.getElementById("dark-toggle");
const body = document.body;

if (localStorage.getItem("darkMode") === "true") {
  body.classList.add("dark");
  toggle.textContent = "Light mode";
}

toggle.addEventListener("click", function() {
  body.classList.toggle("dark");
  const isDark = body.classList.contains("dark");
  localStorage.setItem("darkMode", isDark);
  toggle.textContent = isDark ? "Light mode" : "Dark mode";
});