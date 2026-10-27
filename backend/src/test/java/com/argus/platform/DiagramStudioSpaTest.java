package com.argus.platform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class DiagramStudioSpaTest {
  @Test
  void directDiagramStudioNavigationForwardsToTheExportedShell() throws Exception {
    var mvc = MockMvcBuilders.standaloneSetup(new SpaController()).build();
    var response = mvc.perform(get("/diagram-studio")).andReturn().getResponse();
    assertEquals(200, response.getStatus());
    assertEquals("/index.html", response.getForwardedUrl());
  }
}
