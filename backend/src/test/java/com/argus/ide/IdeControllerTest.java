package com.argus.ide;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class IdeControllerTest {
  @Test
  void navigationPassesOptionalSnapshotHashAndAcceptsOlderRequests() throws Exception {
    var ide = mock(IdeService.class);
    var controller = new IdeController(ide, mock(IdeFiles.class));
    var json = new ObjectMapper();
    for (String hash : new String[] {null, "a".repeat(64)}) {
      var request =
          json.readValue(
              "{\"path\":\"app.ts\",\"line\":3,\"column\":7,\"kind\":\"definition\""
                  + (hash == null ? "" : ",\"expectedHash\":\"" + hash + "\"")
                  + "}",
              IdeController.Navigate.class);
      var result = new IdeService.Navigation(List.of(), "No definition");
      when(ide.navigate("repo", "app.ts", 3, 7, "definition", hash)).thenReturn(result);
      assertSame(result, controller.navigate("repo", request));
      verify(ide).navigate("repo", "app.ts", 3, 7, "definition", hash);
    }
  }
}
