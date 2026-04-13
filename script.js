window.onscroll = function() {

  // Progress bar
  let winScroll = document.body.scrollTop || document.documentElement.scrollTop;
  let height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  let scrolled = (winScroll / height) * 100;
  document.getElementById("progress-bar").style.width = scrolled + "%";

  // Active TOC highlight
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